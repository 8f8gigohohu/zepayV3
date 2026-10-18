from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from .config import Settings
from .storage import Store
from .utils import split_symbol


class RiskViolation(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ValidatedOrder:
    symbol: str
    side: str
    amount: Decimal
    price: Decimal
    notional: Decimal
    base: str
    quote: str


class RiskManager:
    def __init__(self, settings: Settings, store: Store):
        self.settings = settings
        self.store = store

    def validate(
        self,
        symbol: str,
        side: str,
        amount: Decimal,
        price: Decimal,
        market: dict | None = None,
    ) -> ValidatedOrder:
        symbol = symbol.strip().upper().replace("-", "/")
        side = side.lower()
        if symbol not in self.settings.allowed_symbols:
            raise RiskViolation("This market is not in the server-side allowlist")
        if side not in {"buy", "sell"}:
            raise RiskViolation("Side must be buy or sell")
        if not amount.is_finite() or amount <= 0 or not price.is_finite() or price <= 0:
            raise RiskViolation("Amount and price must be finite positive values")

        base, quote = split_symbol(symbol)
        notional = amount * price
        if notional < self.settings.min_order_notional:
            raise RiskViolation(
                f"Order notional {notional} is below the configured minimum "
                f"{self.settings.min_order_notional} {quote}"
            )
        if notional > self.settings.max_order_notional:
            raise RiskViolation(
                f"Order notional {notional} exceeds the per-order cap "
                f"{self.settings.max_order_notional} {quote}"
            )

        if market is not None:
            if market.get("active") is False:
                raise RiskViolation("ZebPay reports this market is not active")
            minimum_amount = market.get("minimum_amount")
            if minimum_amount is not None and amount < Decimal(str(minimum_amount)):
                raise RiskViolation(f"Amount is below the exchange minimum {minimum_amount} {base}")
            exchange_minimum = market.get("minimum_notional")
            if exchange_minimum is not None and notional < Decimal(str(exchange_minimum)):
                raise RiskViolation(f"Notional is below the exchange minimum {exchange_minimum} {quote}")

        today = datetime.now(timezone.utc).date().isoformat()
        daily_total = self.store.daily_notional(self.settings.trading_mode, today)
        if daily_total + notional > self.settings.max_daily_notional:
            raise RiskViolation(
                f"Order would exceed the daily notional cap "
                f"{self.settings.max_daily_notional} {quote}"
            )
        if self.store.open_order_count(self.settings.trading_mode) >= self.settings.max_open_orders:
            raise RiskViolation(f"Open-order cap reached ({self.settings.max_open_orders})")

        return ValidatedOrder(symbol, side, amount, price, notional, base, quote)

    def check_balance(self, order: ValidatedOrder, balances: dict[str, Decimal]) -> None:
        currency = order.quote if order.side == "buy" else order.base
        required = order.notional * Decimal("1.01") if order.side == "buy" else order.amount
        available = Decimal(str(balances.get(currency, Decimal(0))))
        if available < required:
            raise RiskViolation(
                f"Insufficient free {currency}: need approximately {required}, available {available}"
            )
