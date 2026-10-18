from __future__ import annotations

import threading
import time
from decimal import Decimal
from typing import Any

from ..journal import JournalRepository
from ..runtime_config import RiskConfig


class RiskEngine:
    """Multi-layer strategy risk controls; blocks are persisted for audit."""

    def __init__(self, config: RiskConfig, journal: JournalRepository, mode: str = "paper"):
        self.config = config
        self.journal = journal
        self.mode = mode
        last_control = journal.latest_risk_control_event(mode)
        self._halted = bool(last_control and last_control["event_type"] in {"HALT", "CIRCUIT_BREAKER"})
        self._halt_reason: str | None = last_control["reason"] if self._halted and last_control else None
        self._last_loss_time: float | None = journal.last_realized_loss_time(mode)
        self._lock = threading.RLock()

    def update_config(self, config: RiskConfig) -> None:
        with self._lock:
            self.config = config

    def check(
        self,
        order: dict[str, Any],
        position: Decimal,
        equity: Decimal,
        starting_equity: Decimal,
    ) -> tuple[bool, str]:
        symbol = str(order.get("symbol") or "")
        side = str(order.get("side") or "").lower()
        amount = Decimal(str(order.get("amount") or 0))
        price = Decimal(str(order.get("price") or 0))
        with self._lock:
            if self._halted:
                return self._block("HALTED", self._halt_reason or "Risk circuit is halted", symbol)
            if starting_equity > 0:
                drawdown = max(Decimal("0"), (starting_equity - equity) / starting_equity)
                if drawdown >= Decimal(str(self.config.circuit_breaker_pct)):
                    self._halted = True
                    self._halt_reason = f"Circuit breaker: drawdown {drawdown:.2%} reached limit"
                    return self._block("CIRCUIT_BREAKER", self._halt_reason, symbol)

            daily = self.journal.daily_stats(mode=self.mode)
            max_loss = Decimal(str(self.config.max_daily_loss_quote))
            if daily["realized_pnl"] <= -max_loss:
                return self._block("DAILY_LOSS_LIMIT", "Daily realized loss limit reached", symbol)
            if daily["trades"] >= self.config.max_daily_trades:
                return self._block("DAILY_TRADE_LIMIT", "Daily filled-trade count limit reached", symbol)
            if self._last_loss_time is not None:
                elapsed = time.time() - self._last_loss_time
                if elapsed < self.config.cooldown_after_loss_sec:
                    return self._block(
                        "LOSS_COOLDOWN",
                        f"Loss cooldown active for {self.config.cooldown_after_loss_sec - int(elapsed)} more seconds",
                        symbol,
                    )
            if amount <= 0 or price <= 0 or not amount.is_finite() or not price.is_finite():
                return self._block("INVALID_SIZE", "Order amount and price must be finite positive values", symbol)
            notional = amount * price
            max_order = Decimal(str(self.config.max_order_notional_quote))
            if notional > max_order:
                return self._block("ORDER_NOTIONAL_CAP", "Order exceeds the strategy per-order notional cap", symbol)
            daily_notional = self.journal.daily_notional(mode=self.mode)
            if daily_notional + notional > Decimal(str(self.config.max_daily_notional_quote)):
                return self._block("DAILY_NOTIONAL_CAP", "Order would exceed the strategy daily notional cap", symbol)
            if side == "buy" and position + amount > Decimal(str(self.config.max_position_base)):
                return self._block("POSITION_CAP", "Order would exceed the maximum base-asset position", symbol)
            if side == "sell" and amount > position:
                return self._block("POSITION_CAP", "Sell order exceeds the tracked base-asset position", symbol)
            if side not in {"buy", "sell"}:
                return self._block("INVALID_SIDE", "Order side must be buy or sell", symbol)
        return True, "approved"

    def record_trade(self, pnl: Decimal) -> None:
        pnl = Decimal(pnl)
        if pnl < 0:
            with self._lock:
                self._last_loss_time = time.time()
        self.journal.record_risk_event("REALIZED_TRADE", f"Realized PnL: {pnl}", mode=self.mode)

    def halt(self, reason: str = "Manual emergency stop") -> None:
        with self._lock:
            self._halted = True
            self._halt_reason = reason[:300]
        self.journal.record_risk_event("HALT", reason, mode=self.mode)

    def resume(self) -> None:
        with self._lock:
            self._halted = False
            self._halt_reason = None
        self.journal.record_risk_event("RESUME", "Risk engine resumed by operator", mode=self.mode)

    def state(self) -> dict[str, Any]:
        daily = self.journal.daily_stats(mode=self.mode)
        with self._lock:
            return {
                "halted": self._halted,
                "halt_reason": self._halt_reason,
                "limits": self.config.model_dump(mode="json"),
                "daily_trades": daily["trades"],
                "daily_realized_pnl": str(daily["realized_pnl"]),
                "last_loss_time": self._last_loss_time,
                "cooldown_remaining_seconds": max(
                    0,
                    int(self.config.cooldown_after_loss_sec - (time.time() - self._last_loss_time)),
                ) if self._last_loss_time is not None else 0,
            }

    def _block(self, event_type: str, reason: str, symbol: str | None = None) -> tuple[bool, str]:
        self.journal.record_risk_event(event_type, reason, symbol, mode=self.mode)
        return False, reason
