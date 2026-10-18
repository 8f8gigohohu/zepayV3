"""Exchange connection management.

- Stores API keys/secrets encrypted; never returns a secret (masked key only).
- "Test" performs a real capability-specific connectivity check and reports
  exactly what happened. It NEVER reports success from a cached result.
- No credential => all private features reported as disconnected.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit, redact
from ..auth.deps import get_current_user
from ..db import get_db
from ..exchanges import http, registry
from ..exchanges.registry import KNOWN_EXCHANGES
from ..models import ExchangeCredential, User, utcnow
from ..security import encrypt_secret, mask_key

router = APIRouter(prefix="/api/connections", tags=["connections"])

# Connection lifecycle states exposed to the UI. These are derived from what was
# ACTUALLY observed (a stored key alone is never reported as connected).
STATE_NOT_CONFIGURED = "NOT_CONFIGURED"
STATE_CONFIGURED_UNTESTED = "CONFIGURED_UNTESTED"
STATE_CONNECTED_READ_ONLY = "CONNECTED_READ_ONLY"
STATE_VERIFIED_FOR_TRADING = "VERIFIED_FOR_TRADING"
STATE_ERROR = "ERROR"
STATE_UNSUPPORTED = "UNSUPPORTED"


def _derive_state(cred: ExchangeCredential | None, adapter_caps: dict) -> tuple[str, str]:
    """Return (state, explanation). Never upgrades to a connected state without evidence."""
    if cred is None:
        return STATE_NOT_CONFIGURED, "no API credentials stored for this exchange"
    balance_status = adapter_caps.get("account_balances", {}).get("status")
    private_api = adapter_caps.get("private_api", {}).get("status")
    if balance_status == "unsupported" or private_api == "not_implemented":
        return STATE_UNSUPPORTED, ("this adapter has no implemented private/authenticated API "
                                   "(see capability matrix)")
    if cred.last_test_status is None:
        return STATE_CONFIGURED_UNTESTED, "credentials saved but never tested - run Test connection"
    if cred.last_test_status == "ok":
        # Only account READ was verified; order placement is a separate capability and
        # is never inferred here.
        return STATE_CONNECTED_READ_ONLY, "last test read the account successfully (read-only verification)"
    detail = (cred.last_test_detail or "").lower()
    if "not implemented" in detail or "not_implemented" in detail:
        return STATE_UNSUPPORTED, cred.last_test_detail or "capability not implemented"
    return STATE_ERROR, cred.last_test_detail or "last connection test failed"


class CredentialIn(BaseModel):
    exchange: str
    api_key: str = Field(min_length=1, max_length=256)
    api_secret: str = Field(min_length=1, max_length=256)
    test_now: bool = True


@router.get("/status")
async def status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ExchangeCredential)
                             .where(ExchangeCredential.user_id == user.id))).scalars().all()
    by_exchange = {c.exchange: c for c in rows}
    out = []
    for ex in KNOWN_EXCHANGES:
        cred = by_exchange.get(ex)
        caps = registry.get_adapter_notes(ex)["capabilities"]
        private_ok = caps.get("account_balances", {}).get("status")
        state, state_detail = _derive_state(cred, caps)
        out.append({
            "exchange": ex,
            # `connected` stays False unless a real account read succeeded; it is a
            # convenience boolean for the UI, the authoritative value is `state`.
            "connected": state == STATE_CONNECTED_READ_ONLY,
            "state": state,
            "state_detail": state_detail,
            "credential_stored": cred is not None,
            "key_masked": cred.key_masked if cred else None,
            "last_test_status": cred.last_test_status if cred else None,
            "last_test_detail": cred.last_test_detail if cred else None,
            "last_test_at": cred.last_test_at.isoformat() if cred and cred.last_test_at else None,
            "private_api_status": private_ok,
            # Order placement is a per-capability fact, never implied by a connection.
            "place_order_status": caps.get("place_order", {}).get("status"),
            "cancel_order_status": caps.get("cancel_order", {}).get("status"),
            "order_history_status": caps.get("order_history", {}).get("status"),
            "capabilities": caps,
            "trading_state": (STATE_VERIFIED_FOR_TRADING
                              if caps.get("place_order", {}).get("status") == "verified_live"
                              else "NOT_READY_FOR_TRADING"),
        })
    return {"connections": out,
            "guidance": {
                "api_key_permissions": "Create exchange keys with trading ENABLED only if you intend to "
                                       "trade, and with WITHDRAWALS DISABLED always.",
                "ip_whitelist": "Whitelist this server's egress IP at the exchange where supported.",
                "never": "Never paste API secrets into chat, tickets or logs; enter them only in the "
                         "form above. They are encrypted at rest and never returned by any endpoint.",
            }}


@router.post("")
async def save(body: CredentialIn, user: User = Depends(get_current_user),
               db: AsyncSession = Depends(get_db)):
    if body.exchange not in KNOWN_EXCHANGES:
        raise HTTPException(404, f"unsupported exchange {body.exchange}")
    existing = (await db.execute(select(ExchangeCredential).where(
        ExchangeCredential.user_id == user.id,
        ExchangeCredential.exchange == body.exchange))).scalar_one_or_none()
    if existing:
        existing.encrypted_key = encrypt_secret(body.api_key)
        existing.encrypted_secret = encrypt_secret(body.api_secret)
        existing.key_masked = mask_key(body.api_key)
        existing.last_test_status = None
        existing.last_test_detail = None
        cred = existing
    else:
        cred = ExchangeCredential(
            user_id=user.id, exchange=body.exchange,
            key_masked=mask_key(body.api_key),
            encrypted_key=encrypt_secret(body.api_key),
            encrypted_secret=encrypt_secret(body.api_secret))
        db.add(cred)
    await audit(db, "connection.credential_saved", actor_id=user.id,
                detail={"exchange": body.exchange, "key_masked": cred.key_masked})
    await db.refresh(cred)
    result = {"exchange": body.exchange, "key_masked": cred.key_masked, "test": None}
    if body.test_now:
        result["test"] = await test_connection(body.exchange, user, db)
    return result


@router.post("/{exchange}/test")
async def test_connection(exchange: str, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    if exchange not in KNOWN_EXCHANGES:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    cred = (await db.execute(select(ExchangeCredential).where(
        ExchangeCredential.user_id == user.id,
        ExchangeCredential.exchange == exchange))).scalar_one_or_none()
    if cred is None:
        raise HTTPException(404, f"no credential stored for {exchange}")
    adapter = registry.get_adapter(exchange)
    detail: str
    try:
        env = await adapter.account(cred)
        assets = len(env.data.get("balances", []))
        unit = env.data.get("timestamp_unit")
        cred.last_test_status, detail = "ok", (f"account read ok ({assets} assets)"
                                               + (f" - signed with {unit} timestamp" if unit else ""))
        connected = True
    except NotImplementedError as e:
        cred.last_test_status, detail = "fail", str(e)
        connected = False
    except http.UpstreamError as e:
        cred.last_test_status, detail = "fail", str(e)
        if e.status in (403, 451):
            detail += " [upstream geo/network restriction - not an authentication failure]"
        connected = False
    except Exception as e:
        cred.last_test_status, detail = "fail", f"{type(e).__name__}: {e}"
        connected = False
    # Persist the failure/success detail itself - it is what the UI shows and what
    # state derivation inspects. (Previously only the status was stored, so the
    # reason for a failed test was lost after the response.) Bounded: an upstream
    # body must not be able to bloat the row, the response or the audit entry.
    detail = detail[:400]
    cred.last_test_detail = detail
    cred.last_test_at = utcnow()
    caps = registry.get_adapter_notes(exchange)["capabilities"]
    state, state_detail = _derive_state(cred, caps)
    await audit(db, "connection.test", actor_id=user.id,
                detail={"exchange": exchange, "status": cred.last_test_status,
                        "detail": detail, "connected": connected, "state": state})
    return {"exchange": exchange, "connected": connected,
            "status": cred.last_test_status, "detail": redact(detail),
            "state": state, "state_detail": state_detail,
            "place_order_status": caps.get("place_order", {}).get("status")}


@router.get("/{exchange}/account")
async def account_snapshot(exchange: str, user: User = Depends(get_current_user),
                           db: AsyncSession = Depends(get_db)):
    """Read-only account snapshot (balances). Authentication, decryption and the
    upstream signature all happen server-side; the secret never reaches the client.

    This is a READ. No order path exists here, and a successful read does not
    imply that order placement is implemented for the exchange.
    """
    if exchange not in KNOWN_EXCHANGES:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    cred = (await db.execute(select(ExchangeCredential).where(
        ExchangeCredential.user_id == user.id,
        ExchangeCredential.exchange == exchange))).scalar_one_or_none()
    if cred is None:
        raise HTTPException(404, f"no credential stored for {exchange}")
    adapter = registry.get_adapter(exchange)
    caps = registry.get_adapter_notes(exchange)["capabilities"]
    try:
        env = await adapter.account(cred)
    except NotImplementedError as e:
        raise HTTPException(501, str(e)[:400]) from e
    except http.UpstreamError as e:
        msg = str(e)[:400]
        if e.status in (403, 451):
            msg += " [upstream geo/network restriction - not an authentication failure]"
        raise HTTPException(502, msg) from e
    except Exception as e:  # network down, malformed payload
        raise HTTPException(502, f"{type(e).__name__}: {e}"[:400]) from e
    return {
        "exchange": exchange,
        "endpoint": env.endpoint,
        "source_url": env.source_url,
        "verified": env.verified.value,
        "ts_ms": env.ts_ms,
        "age_ms": env.age_ms,
        "data": env.data,
        "place_order_status": caps.get("place_order", {}).get("status"),
        "read_only": True,
    }


@router.delete("/{exchange}")
async def delete_credential(exchange: str, user: User = Depends(get_current_user),
                            db: AsyncSession = Depends(get_db)):
    cred = (await db.execute(select(ExchangeCredential).where(
        ExchangeCredential.user_id == user.id,
        ExchangeCredential.exchange == exchange))).scalar_one_or_none()
    if not cred:
        raise HTTPException(404, "no stored credential")
    await db.delete(cred)
    await audit(db, "connection.credential_deleted", actor_id=user.id,
                detail={"exchange": exchange})
    return {"deleted": exchange, "key_masked": cred.key_masked}
