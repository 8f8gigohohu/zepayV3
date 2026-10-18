from __future__ import annotations

import asyncio
from datetime import datetime
from decimal import Decimal
from typing import Any

from .order_tracker import InFlightOrder, OrderState, OrderTracker
from ..schemas import LimitOrderRequest
from ..trading import TradingService


_STATUS_STATE = {
    "submitting": OrderState.PENDING_CREATE,
    "open": OrderState.OPEN,
    "partially_filled": OrderState.PARTIALLY_FILLED,
    "filled": OrderState.FILLED,
    "canceled": OrderState.CANCELLED,
    "cancelled": OrderState.CANCELLED,
    "failed": OrderState.FAILED,
    "expired": OrderState.EXPIRED,
    "unknown": OrderState.OPEN,
    "pending_cancel": OrderState.PENDING_CANCEL,
}


class OrderEngine:
    """Routes order actions through the existing risk-checked trading service."""

    def __init__(self, service: TradingService, tracker: OrderTracker):
        self.service = service
        self.tracker = tracker

    def execute(self, request: LimitOrderRequest, operator_authenticated: bool = False) -> dict[str, Any]:
        result = self.service.place_order(request, operator_authenticated=operator_authenticated)
        self.track(result)
        return result

    def cancel(self, client_order_id: str, symbol: str | None = None) -> dict[str, Any]:
        result = self.service.cancel_order(client_order_id, symbol)
        self.track(result)
        return result

    def track(self, order: dict[str, Any]) -> InFlightOrder:
        client_id = str(order["client_order_id"])
        created = order.get("created_at")
        if isinstance(created, str):
            try:
                created_at = datetime.fromisoformat(created).timestamp()
            except ValueError:
                created_at = 0.0
        else:
            created_at = float(created or 0.0)
        state = _STATUS_STATE.get(str(order.get("status", "open")).lower(), OrderState.OPEN)
        inflight = InFlightOrder(
            client_order_id=client_id,
            exchange_order_id=str(order["exchange_order_id"]) if order.get("exchange_order_id") else None,
            trading_pair=str(order["symbol"]),
            order_type=str(order.get("order_type", "limit")).upper(),
            trade_type=str(order["side"]).upper(),
            amount=Decimal(str(order["amount"])),
            price=Decimal(str(order["price"])),
            state=state,
            filled_amount=Decimal(str(order.get("filled") or "0")),
            average_fill_price=Decimal(str(order.get("average_fill_price") or 0)),
            created_at=created_at,
            updated_at=created_at,
        )
        existing = self.tracker.get(client_id)
        if existing is None:
            return self.tracker.add(inflight)
        return self.tracker.update_state(
            client_id,
            state,
            inflight.filled_amount,
            inflight.average_fill_price,
        ) or inflight

    def hydrate(self, orders: list[dict[str, Any]]) -> None:
        for order in reversed(orders):
            self.track(order)

    async def reconcile(self) -> list[dict[str, Any]]:
        """Refresh the durable order ledger, then hydrate tracker state from it.

        TradingService performs the fill-delta accounting and exchange reconciliation;
        this layer keeps the Hummingbot-style in-flight state synchronized without
        issuing duplicate reads or retrying an uncertain submission.
        """
        orders = await asyncio.to_thread(self.service.list_orders)
        self.hydrate(orders)
        return orders
