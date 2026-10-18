"""Order submission - fail-closed. In Milestone 1 every path ends in a rejected,
audited order attempt because (a) live trading is disabled by config, (b) the
kill switch defaults active, (c) adapters do not implement submission yet.
Even with (a)&(b) released, (c) makes submission impossible - by design."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..auth.deps import get_current_user
from ..db import get_db
from ..exchanges import registry
from ..exchanges.registry import KNOWN_EXCHANGES
from ..models import Setting, User
from ..risk.engine import KILL_SWITCH_KEY, OrderRequest, RiskEngine

router = APIRouter(prefix="/api/trading", tags=["trading"])

_seen_idempotency: set[str] = set()  # M1 in-memory guard; DB-backed uniqueness lands in M2


class OrderIn(BaseModel):
    exchange: str
    symbol: str
    side: str
    type: str
    quantity_quote: float | None = None
    idempotency_key: str = Field(min_length=8, max_length=64)

    @field_validator("side", "type")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()


@router.post("/orders")
async def submit_order(body: OrderIn, user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    if body.exchange not in KNOWN_EXCHANGES:
        raise HTTPException(404, f"unsupported exchange {body.exchange}")

    kill = (await db.execute(select(Setting).where(Setting.key == KILL_SWITCH_KEY))).scalar_one_or_none()
    kill_active = (kill.value or {}).get("active", True) if kill else True

    if body.idempotency_key in _seen_idempotency:
        await audit(db, "order.duplicate_blocked", actor_id=user.id, detail=body.model_dump())
        # Idempotent behavior: do not re-submit; acknowledge as already-received.
        return {"status": "duplicate", "accepted": False,
                "idempotency_key": body.idempotency_key}
    _seen_idempotency.add(body.idempotency_key)

    caps = {k: v.status.value for k, v in registry.get_adapter(body.exchange).capabilities.items()}
    engine = RiskEngine()
    decision = engine.check(
        OrderRequest(exchange=body.exchange, symbol=body.symbol, side=body.side,
                     type=body.type, quantity_quote=body.quantity_quote,
                     idempotency_key=body.idempotency_key, live_trading=True),
        kill_switch_active=kill_active,
        adapter_caps=caps,
    )
    await audit(db, "order.decision", actor_id=user.id,
                detail={"order": body.model_dump(), "allowed": decision.allowed,
                        "reasons": decision.reasons})
    if not decision.allowed:
        return {"status": "rejected", "accepted": False,
                "reasons": decision.reasons, "idempotency_key": body.idempotency_key}

    # Unreachable in M1 (risk gate refuses place_order), kept for M2 pipeline honesty.
    raise HTTPException(501, "order routing is not implemented in Milestone 1")
