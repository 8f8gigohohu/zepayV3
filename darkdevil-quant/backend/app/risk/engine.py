"""Risk engine - independent of any strategy or adapter code.

Design: every order request passes here first. The engine fails CLOSED:
if any check cannot be established, the order is rejected with a reason.

Milestone 1 status: live trading is hard-disabled at config level AND the
kill switch defaults to ACTIVE, AND no adapter implements order submission -
three independent fail-closed layers.
"""
from dataclasses import dataclass, field

from ..config import get_settings

KILL_SWITCH_KEY = "risk.kill_switch"


@dataclass
class OrderRequest:
    exchange: str
    symbol: str
    side: str                      # buy | sell
    type: str                      # market | limit
    quantity_quote: float | None   # quote notional requested (price*qty resolved upstream in M2)
    idempotency_key: str
    live_trading: bool = False     # user's explicit intent flag


@dataclass
class RiskDecision:
    allowed: bool
    reasons: list[str] = field(default_factory=list)

    @property
    def reason(self) -> str:
        return "; ".join(self.reasons) or "ok"


class RiskEngine:
    def __init__(self, config=None):
        self.cfg = config or get_settings()

    def check(self, req: OrderRequest, *, kill_switch_active: bool,
              adapter_caps: dict[str, str] | None = None,
              market_ts_ms: int | None = None, now_ms_: int | None = None) -> RiskDecision:
        d = RiskDecision(allowed=True)
        add = d.reasons.append

        # 1. Kill switch (session-independent)
        if kill_switch_active:
            add("kill switch is ACTIVE - new orders are blocked")

        # 2. Global live-trading gate
        if not self.cfg.live_trading_enabled:
            add("live trading is globally DISABLED (set DJQ_LIVE_TRADING_ENABLED=true to change)")
        elif not req.live_trading:
            add("request did not confirm live trading intent")

        # 3. Adapter capability: order placement must be implemented & verified
        cap = (adapter_caps or {}).get("place_order")
        if cap in (None, "not_implemented", "needs_verification", "unsupported", "verified_docs"):
            add(f"adapter 'place_order' capability is {cap or 'unknown'} - refusing to submit")

        # 4. Input sanity
        if req.side not in ("buy", "sell"):
            add(f"invalid side {req.side!r}")
        if req.type not in ("market", "limit"):
            add(f"invalid order type {req.type!r}")
        if req.type == "limit" and req.quantity_quote is None:
            add("limit order requires notional")
        if req.quantity_quote is not None and req.quantity_quote <= 0:
            add("notional must be > 0")
        elif req.quantity_quote is not None and req.quantity_quote > self.cfg.max_order_notional_quote:
            add(f"notional {req.quantity_quote} exceeds max_order_notional_quote "
                f"{self.cfg.max_order_notional_quote}")
        if not req.idempotency_key:
            add("idempotency_key is required")

        # 5. Market data freshness - refuse orders on stale data
        if market_ts_ms is not None and now_ms_ is not None:
            age = now_ms_ - market_ts_ms
            if age > 30_000:
                add(f"market data is stale ({age / 1000:.1f}s old > 30s limit)")

        d.allowed = not d.reasons
        return d
