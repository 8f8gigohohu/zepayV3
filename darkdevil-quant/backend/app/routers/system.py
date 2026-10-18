"""System endpoints: health, exchange connectivity (honest, cached)."""
import time

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..auth.deps import get_current_user, require_role
from ..config import get_settings
from ..db import get_db
from ..exchanges import http, registry
from ..models import Setting
from ..risk.engine import KILL_SWITCH_KEY

router = APIRouter(prefix="/api/system", tags=["system"])

_status_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 30.0


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    db_ok = True
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    s = get_settings()
    return {
        "status": "ok" if db_ok else "degraded",
        "database": "ok" if db_ok else "error",
        "environment": s.environment,
        # Effective trading is disabled: no adapter implements a verified order path.
        # Keep an explicitly separate config flag so environment intent is not hidden.
        "live_trading_enabled": False,
        "live_trading_configured": s.live_trading_enabled,
        "live_order_routing_supported": False,
        "kill_switch_default_active": s.kill_switch_default_active,
    }


@router.get("/exchanges")
async def exchange_status():
    checks = {}
    now = time.monotonic()
    for name in ("binance", "zebpay"):
        cached = _status_cache.get(name)
        if cached and (now - cached[0]) < CACHE_TTL:
            checks[name] = {**cached[1], "cached": True}
            continue
        reachable = False
        error = None
        restricted = False
        try:
            await registry.get_adapter(name).ping()
            reachable = True
        except http.UpstreamError as e:
            error = str(e)
            restricted = e.status in (403, 451)
        except Exception as e:  # network down etc.
            error = f"{e.__class__.__name__}: {str(e)[:240]}"
        # Read capabilities after ping: ZebPay only promotes public data to
        # VERIFIED_LIVE once this process has reached its official endpoint.
        info = registry.get_adapter_notes(name)
        entry = {"registered": True, "overall": info["overall"],
                 "capabilities": info["capabilities"], "reachable": reachable, "error": error,
                 "restricted": restricted, "cached": False}
        _status_cache[name] = (now, entry)
        checks[name] = entry
    return {"exchanges": checks}


@router.get("/risk")
async def risk_status(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Read-only view of the configured risk gates and limits. Exposes the exact
    values the engine uses - nothing here is inferred or beautified for the UI."""
    s = get_settings()
    row = (await db.execute(select(Setting).where(Setting.key == KILL_SWITCH_KEY))).scalar_one_or_none()
    kill_value = row.value if row is not None else None
    default_active = s.kill_switch_default_active
    kill_active = (kill_value or {}).get("active", default_active) if row else default_active
    return {
        "gates": [
            {"name": "kill_switch", "blocking": bool(kill_active),
             "detail": ("blocks every new order regardless of other configuration" if kill_active
                        else "released - other gates still apply")},
            {"name": "live_trading_config", "blocking": not s.live_trading_enabled,
             "detail": ("DJQ_LIVE_TRADING_ENABLED is false, so order routing cannot proceed"
                        if not s.live_trading_enabled
                        else "enabled by configuration - adapter capability still required")},
            {"name": "adapter_capability", "blocking": True,
             "detail": "place_order is not implemented/verified for any registered adapter"},
            {"name": "market_data_freshness", "blocking": False,
             "detail": "orders are rejected when market data is older than 30s (enforced at order time)"},
        ],
        "limits": {
            "max_order_notional_quote": s.max_order_notional_quote,
            "max_daily_realized_loss_quote": s.max_daily_realized_loss_quote,
            "max_open_position_notional_quote": s.max_open_position_notional_quote,
            "max_market_data_age_ms": 30_000,
        },
        "kill_switch": {"active": bool(kill_active),
                        "source": "database override" if row else "configuration default"},
        "live_trading_enabled": False,
        "live_trading_configured": s.live_trading_enabled,
        "live_order_routing_supported": False,
        "note": ("Live order routing is not implemented; every order attempt is recorded in the "
                 "append-only audit log, including rejections."),
    }


@router.post("/kill-switch", tags=["risk"])
async def set_kill_switch(payload: dict, user=Depends(require_role("admin")),
                          db: AsyncSession = Depends(get_db)):
    active = bool(payload.get("active"))
    setting = (await db.execute(select(Setting).where(Setting.key == KILL_SWITCH_KEY))).scalar_one_or_none()
    if setting is None:
        setting = Setting(key=KILL_SWITCH_KEY)
        db.add(setting)
    setting.value = {"active": active}
    await audit(db, "risk.kill_switch", actor_id=user.id, detail={"active": active})
    return {"kill_switch_active": active}
