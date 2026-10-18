from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from decimal import Decimal
from enum import IntEnum
from typing import Any, Awaitable, Callable


class OrderState(IntEnum):
    PENDING_CREATE = 0
    OPEN = 1
    PENDING_CANCEL = 2
    PARTIALLY_FILLED = 4
    FILLED = 5
    CANCELLED = 6
    FAILED = 7
    EXPIRED = 8


@dataclass(slots=True)
class InFlightOrder:
    client_order_id: str
    exchange_order_id: str | None
    trading_pair: str
    order_type: str
    trade_type: str
    amount: Decimal
    price: Decimal
    state: OrderState
    filled_amount: Decimal
    average_fill_price: Decimal
    created_at: float
    updated_at: float

    @property
    def is_open(self) -> bool:
        return self.state in {
            OrderState.PENDING_CREATE,
            OrderState.OPEN,
            OrderState.PENDING_CANCEL,
            OrderState.PARTIALLY_FILLED,
        }

    @property
    def is_done(self) -> bool:
        return self.state in {OrderState.FILLED, OrderState.CANCELLED, OrderState.FAILED, OrderState.EXPIRED}

    @property
    def is_filled(self) -> bool:
        return self.state == OrderState.FILLED

    @property
    def is_failure(self) -> bool:
        return self.state in {OrderState.FAILED, OrderState.EXPIRED}

    def to_dict(self) -> dict[str, Any]:
        return {
            "client_order_id": self.client_order_id,
            "exchange_order_id": self.exchange_order_id,
            "trading_pair": self.trading_pair,
            "order_type": self.order_type,
            "trade_type": self.trade_type,
            "amount": str(self.amount),
            "price": str(self.price),
            "state": self.state.name,
            "state_code": int(self.state),
            "filled_amount": str(self.filled_amount),
            "average_fill_price": str(self.average_fill_price),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "is_open": self.is_open,
            "is_done": self.is_done,
        }


StateCallback = Callable[[str, InFlightOrder, InFlightOrder], None | Awaitable[None]]


class OrderTracker:
    """Thread-safe in-memory Hummingbot-style state tracker with async reconciliation."""

    _REMOTE_STATES = {
        "NEW": OrderState.OPEN,
        "OPEN": OrderState.OPEN,
        "ACTIVE": OrderState.OPEN,
        "PENDING": OrderState.OPEN,
        "PARTIALLY_FILLED": OrderState.PARTIALLY_FILLED,
        "FILLED": OrderState.FILLED,
        "CLOSED": OrderState.FILLED,
        "COMPLETED": OrderState.FILLED,
        "CANCELED": OrderState.CANCELLED,
        "CANCELLED": OrderState.CANCELLED,
        "REJECTED": OrderState.FAILED,
        "FAILED": OrderState.FAILED,
        "EXPIRED": OrderState.EXPIRED,
    }

    def __init__(self, callback: StateCallback | None = None):
        self._orders: dict[str, InFlightOrder] = {}
        self._lock = threading.RLock()
        self._callback = callback

    def add(self, order: InFlightOrder) -> InFlightOrder:
        with self._lock:
            existing = self._orders.get(order.client_order_id)
            if existing is not None:
                return existing
            self._orders[order.client_order_id] = order
        self._emit("on_order_created", order, order)
        return order

    def get(self, client_order_id: str) -> InFlightOrder | None:
        with self._lock:
            return self._orders.get(client_order_id)

    def active_orders(self) -> list[InFlightOrder]:
        with self._lock:
            return [order for order in self._orders.values() if order.is_open]

    def all_orders(self) -> list[InFlightOrder]:
        with self._lock:
            return list(self._orders.values())

    def update_state(
        self,
        client_order_id: str,
        state: OrderState,
        filled: Decimal | None = None,
        average_fill_price: Decimal | None = None,
    ) -> InFlightOrder | None:
        with self._lock:
            order = self._orders.get(client_order_id)
            if order is None:
                return None
            previous = InFlightOrder(**{field: getattr(order, field) for field in order.__dataclass_fields__})
            if order.is_done and state != order.state:
                return order
            order.state = state
            if filled is not None:
                order.filled_amount = max(Decimal("0"), min(order.amount, Decimal(filled)))
            if average_fill_price is not None and Decimal(average_fill_price) > 0:
                order.average_fill_price = Decimal(average_fill_price)
            order.updated_at = time.time()
        if previous.state != state or previous.filled_amount != order.filled_amount:
            event = self._state_event(state)
            self._emit(event, previous, order)
        return order

    async def reconcile(self, exchange: Any) -> list[dict[str, Any]]:
        """Reconcile each active exchange order. Unknown states never trigger a retry."""
        changes: list[dict[str, Any]] = []
        symbols = sorted({order.trading_pair for order in self.active_orders() if order.exchange_order_id})
        open_ids: dict[str, set[str]] = {}
        for symbol in symbols:
            try:
                remote_orders = await asyncio.to_thread(exchange.open_orders, symbol)
                open_ids[symbol] = {str(item.get("id")) for item in remote_orders if item.get("id") is not None}
            except Exception:
                open_ids[symbol] = set()
        for order in self.active_orders():
            if not order.exchange_order_id:
                continue
            try:
                if order.exchange_order_id in open_ids.get(order.trading_pair, set()):
                    remote = await asyncio.to_thread(exchange.fetch_order, order.exchange_order_id, order.trading_pair)
                else:
                    # An order missing from the open list must be checked by id before being marked terminal.
                    remote = await asyncio.to_thread(exchange.fetch_order, order.exchange_order_id, order.trading_pair)
                status = str(remote.get("status") or "").upper()
                state = self._REMOTE_STATES.get(status)
                if state is None:
                    continue
                updated = self.update_state(
                    order.client_order_id,
                    state,
                    Decimal(str(remote.get("filled") or "0")),
                    Decimal(str(remote.get("average") or remote.get("averagePrice") or "0")),
                )
                if updated is not None:
                    changes.append(updated.to_dict())
            except Exception:
                # Keep the last known state through transient network/API errors.
                continue
        return changes

    def _emit(self, name: str, previous: InFlightOrder, current: InFlightOrder) -> None:
        if self._callback is None:
            return
        try:
            result = self._callback(name, previous, current)
            if asyncio.iscoroutine(result):
                try:
                    asyncio.get_running_loop().create_task(result)
                except RuntimeError:
                    result.close()
        except Exception:
            # Observability callbacks must not break order state transitions.
            return

    @staticmethod
    def _state_event(state: OrderState) -> str:
        return {
            OrderState.FILLED: "on_order_filled",
            OrderState.CANCELLED: "on_order_cancelled",
            OrderState.FAILED: "on_order_failed",
            OrderState.EXPIRED: "on_order_failed",
        }.get(state, "on_order_updated")
