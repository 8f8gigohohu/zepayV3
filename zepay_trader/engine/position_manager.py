from __future__ import annotations

from decimal import Decimal
from typing import Any

from ..journal import JournalRepository


class PositionManager:
    def __init__(self, journal: JournalRepository, mode: str = "paper"):
        self.journal = journal
        self.mode = mode

    def apply_fill(
        self,
        *,
        trade_id: str,
        client_order_id: str,
        exchange_order_id: str | None,
        symbol: str,
        side: str,
        amount: Decimal,
        price: Decimal,
        fee: Decimal = Decimal("0"),
        fee_currency: str | None = None,
    ) -> dict[str, Any] | None:
        return self.journal.apply_fill(
            trade_id=trade_id,
            client_order_id=client_order_id,
            exchange_order_id=exchange_order_id,
            symbol=symbol,
            side=side,
            amount=amount,
            price=price,
            fee=fee,
            fee_currency=fee_currency,
            mode=self.mode,
        )

    def get_position(self, symbol: str) -> dict[str, Any] | None:
        return self.journal.get_position(symbol, self.mode)

    def positions(self, marks: dict[str, Decimal] | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for position in self.journal.list_positions(self.mode):
            amount = Decimal(position["amount"])
            average_entry = Decimal(position["average_entry"])
            mark = (marks or {}).get(position["symbol"])
            unrealized = (Decimal(mark) - average_entry) * amount if mark is not None else None
            result.append({
                **position,
                "mark_price": str(mark) if mark is not None else None,
                "unrealized_pnl": str(unrealized) if unrealized is not None else None,
                "total_pnl": str(Decimal(position["realized_pnl"]) + unrealized) if unrealized is not None else None,
            })
        return result
