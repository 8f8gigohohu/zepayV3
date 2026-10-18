from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from .config import LIVE_ORDER_ROUTING_BLOCK_REASON, Settings
from .events import LiveEventHub
from .exchange import ExchangeGateway, ExchangeUnavailable
from .journal import JournalRepository
from .engine.position_manager import PositionManager
from .kronos import KronosAdapter
from .risk import RiskManager, RiskViolation
from .schemas import LimitOrderRequest
from .storage import Store
from .utils import decimal_text, normalize_symbol, split_symbol


SUPPORTED_TIMEFRAMES = frozenset({"1m", "5m", "15m", "1h", "4h", "1d"})


class LiveTradingDisabled(RuntimeError):
    pass


class OperatorAuthenticationRequired(RuntimeError):
    pass


class TradingService:
    def __init__(
        self,
        settings: Settings,
        gateway: ExchangeGateway,
        store: Store,
        kronos: KronosAdapter,
        journal: JournalRepository | None = None,
        events: LiveEventHub | None = None,
        strategy_risk: Any | None = None,
    ):
        self.settings = settings
        self.gateway = gateway
        self.store = store
        self.kronos = kronos
        self.journal = journal or JournalRepository(settings.database_path)
        self.positions = PositionManager(self.journal, settings.trading_mode)
        self.events = events
        self.strategy_risk = strategy_risk
        self.risk = RiskManager(settings, store)
        self._order_lock = threading.RLock()

    def get_market(self, symbol: str) -> dict[str, Any]:
        symbol = self._allowed_symbol(symbol)
        quote = self.gateway.ticker(symbol)
        last = _decimal_or_none(quote.get("last"))
        if last is None or last <= 0:
            raise ExchangeUnavailable("ZebPay returned no valid last price; trading is blocked")
        if self.settings.trading_mode == "paper":
            self._match_paper_orders(symbol, quote)
        if self.events is not None:
            self.events.publish("market_update", quote)
        return quote

    def get_candles(self, symbol: str, timeframe: str = "5m", limit: int = 120) -> list[list[float]]:
        symbol = self._allowed_symbol(symbol)
        if timeframe not in SUPPORTED_TIMEFRAMES:
            raise ValueError("Unsupported timeframe")
        limit = max(20, min(int(limit), 300))
        result = self.gateway.candles(symbol, timeframe, limit)
        if not result:
            raise ExchangeUnavailable("ZebPay returned no candles")
        return result[-limit:]

    def order_book(self, symbol: str, limit: int = 100) -> dict[str, Any]:
        normalized = self._allowed_symbol(symbol)
        limit = max(5, min(int(limit), 200))
        book = self.gateway.order_book(normalized, limit)
        return {
            "symbol": normalized,
            "timestamp": book.get("timestamp"),
            "bids": book.get("bids", [])[:limit],
            "asks": book.get("asks", [])[:limit],
            "source": "zebpay",
        }

    def recent_market_trades(self, symbol: str, limit: int = 50) -> list[dict[str, Any]]:
        normalized = self._allowed_symbol(symbol)
        return self.gateway.recent_trades(normalized, max(1, min(int(limit), 200)))

    def positions_snapshot(self) -> list[dict[str, Any]]:
        marks: dict[str, Decimal] = {}
        for position in self.journal.list_positions(self.settings.trading_mode):
            try:
                quote = self.get_market(position["symbol"])
                last = _decimal_or_none(quote.get("last"))
                if last is not None and last > 0:
                    marks[position["symbol"]] = last
            except Exception:
                continue
        return self.positions.positions(marks)

    def portfolio(self) -> dict[str, Any]:
        if self.settings.trading_mode == "paper":
            total_balances = self.store.paper_balances()
            free_balances = self.store.paper_available_balances()
        else:
            raw_balances = self.gateway.balance()
            total_balances = {asset: value["total"] for asset, value in raw_balances.items()}
            free_balances = {asset: value["free"] for asset, value in raw_balances.items()}

        equity = Decimal(0)
        value_complete = True
        balance_rows: list[dict[str, Any]] = []
        for currency in sorted(set(total_balances) | set(free_balances)):
            total = Decimal(str(total_balances.get(currency, 0)))
            free = Decimal(str(free_balances.get(currency, 0)))
            if total == 0 and free == 0:
                continue
            used = max(Decimal(0), total - free)
            if currency == "INR":
                mark_price = Decimal(1)
                value = total
            else:
                try:
                    quote = self.get_market(f"{currency}/INR")
                    mark_price = Decimal(str(quote["last"]))
                    value = total * mark_price
                except Exception:
                    mark_price = None
                    value = None
                    value_complete = False
            if value is not None:
                equity += value
            balance_rows.append({
                "currency": currency,
                "total": decimal_text(total),
                "free": decimal_text(free),
                "used": decimal_text(used),
                "mark_price_inr": decimal_text(mark_price) if mark_price is not None else None,
                "value_inr": decimal_text(value) if value is not None else None,
            })

        return {
            "mode": self.settings.trading_mode,
            "quote_currency": "INR",
            "equity_inr": decimal_text(equity) if value_complete else None,
            "equity_complete": value_complete,
            "day_pnl_inr": None,
            "balances": balance_rows,
            "open_orders": self.store.open_order_count(self.settings.trading_mode),
            "daily_notional": decimal_text(self.store.daily_notional(
                self.settings.trading_mode, datetime.now(timezone.utc).date().isoformat()
            )),
        }

    def list_orders(self, symbol: str | None = None) -> list[dict[str, Any]]:
        normalized = self._allowed_symbol(symbol) if symbol else None
        orders = self.store.list_orders(self.settings.trading_mode, normalized)
        if self.settings.trading_mode == "live":
            # Refresh only orders recorded by this app. Unknown submissions are deliberately not retried.
            for order in orders:
                if order["status"] not in {"open", "partially_filled"} or not order.get("exchange_order_id"):
                    continue
                try:
                    remote = self.gateway.fetch_order(order["exchange_order_id"], order["symbol"])
                    updates = self._reconcile_live_fill(order, remote)
                    self.store.update_order(order["client_order_id"], **updates)
                except ExchangeUnavailable:
                    # Retain the last known state; transient read failures must not mutate orders.
                    pass
            orders = self.store.list_orders(self.settings.trading_mode, normalized)
        if self.events is not None:
            self.events.publish("orders_snapshot", orders)
        return orders

    def place_order(self, request: LimitOrderRequest, operator_authenticated: bool = False) -> dict[str, Any]:
        # Serialize local risk-check/submit sequences so simultaneous requests cannot
        # race the daily, open-order, and free-balance checks in a single worker.
        with self._order_lock:
            symbol = self._allowed_symbol(request.symbol)
            if request.order_type != "limit":
                raise RiskViolation("Only spot limit orders are enabled")

            if self.settings.trading_mode == "live":
                return self._place_live_order(request, symbol, operator_authenticated)
            return self._place_paper_order(request, symbol)

    def _reconcile_live_fill(self, order: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
        previous_filled = Decimal(str(order.get("filled") or "0"))
        remote_filled = _decimal_or_none(remote.get("filled"))
        total_filled = min(
            Decimal(str(order["amount"])),
            max(previous_filled, remote_filled if remote_filled is not None else previous_filled),
        )
        previous_raw = order.get("raw") if isinstance(order.get("raw"), dict) else {}
        average_price = (
            _decimal_or_none(remote.get("average"))
            or _decimal_or_none(remote.get("averagePrice"))
            or _decimal_or_none(remote.get("price"))
            or Decimal(str(order["price"]))
        )
        previous_average = (
            _decimal_or_none(previous_raw.get("reconciled_average_price"))
            or Decimal(str(order["price"]))
        )
        fee_info = remote.get("fee") if isinstance(remote.get("fee"), dict) else {}
        previous_fee = _decimal_or_none(previous_raw.get("reconciled_fee_total")) or Decimal("0")
        reported_fee = _decimal_or_none(fee_info.get("cost"))
        total_fee = max(previous_fee, reported_fee if reported_fee is not None else previous_fee)
        fill_delta = total_filled - previous_filled
        fee_delta = max(Decimal("0"), total_fee - previous_fee)

        if fill_delta > 0:
            incremental_price = average_price
            if total_filled > 0:
                incremental_price = (
                    average_price * total_filled - previous_average * previous_filled
                ) / fill_delta
            if incremental_price <= 0 or not incremental_price.is_finite():
                incremental_price = average_price
            try:
                position = self.positions.apply_fill(
                    trade_id=f"live:{order['exchange_order_id']}:{decimal_text(total_filled)}",
                    client_order_id=order["client_order_id"],
                    exchange_order_id=order["exchange_order_id"],
                    symbol=order["symbol"],
                    side=order["side"],
                    amount=fill_delta,
                    price=incremental_price,
                    fee=fee_delta,
                    fee_currency=fee_info.get("currency"),
                )
                if position is not None:
                    self._record_realized_fill(position)
                    if self.events is not None:
                        self.events.publish("position_update", position)
            except ValueError as accounting_error:
                self.journal.record_risk_event(
                    "POSITION_RECONCILIATION",
                    f"Exchange-confirmed fill could not be applied to tracked cost basis: {accounting_error}",
                    order["symbol"],
                    mode=self.settings.trading_mode,
                )

        stored_raw = {
            **remote,
            "reconciled_fee_total": decimal_text(total_fee),
            "reconciled_average_price": decimal_text(average_price),
        }
        return {
            "status": _status(remote.get("status"), default="open"),
            "filled": total_filled,
            "raw": stored_raw,
        }

    def _place_paper_order(self, request: LimitOrderRequest, symbol: str) -> dict[str, Any]:
        self._validate_tracked_sell(symbol, request.side, request.amount)
        quote = self.get_market(symbol)
        validated = self.risk.validate(symbol, request.side, request.amount, request.price)
        free = self.store.paper_available_balances()
        self.risk.check_balance(validated, free)
        client_id = f"P-{uuid.uuid4().hex[:20]}"
        order = self.store.create_order({
            "client_order_id": client_id,
            "mode": "paper",
            "symbol": symbol,
            "side": validated.side,
            "order_type": "limit",
            "amount": validated.amount,
            "price": validated.price,
            "filled": Decimal(0),
            "status": "open",
            "raw": {"simulated": True, "quote_source": quote.get("source")},
        })
        self._publish_order(order)
        self._match_one_paper_order(order, quote)
        final_order = self.store.get_order(client_id) or order
        self._publish_order(final_order)
        return final_order

    def _place_live_order(
        self,
        request: LimitOrderRequest,
        symbol: str,
        operator_authenticated: bool,
    ) -> dict[str, Any]:
        # Defense in depth: never reach CCXT's write methods while ZebPay's
        # official order contract remains contradictory. No request is sent.
        raise LiveTradingDisabled(
            f"Live ZebPay order routing is fail-closed: {LIVE_ORDER_ROUTING_BLOCK_REASON}"
        )

    def cancel_order(self, client_order_id: str, symbol: str | None = None) -> dict[str, Any]:
        order = self.store.get_order(client_order_id)
        if order is None or order["mode"] != self.settings.trading_mode:
            raise ValueError("Order not found in this trading desk")
        if symbol and normalize_symbol(symbol) != order["symbol"]:
            raise ValueError("Order symbol does not match")
        if order["status"] not in {"open", "partially_filled"}:
            raise RiskViolation(f"Only open orders can be canceled (current state: {order['status']})")

        if self.settings.trading_mode == "paper":
            canceled = self.store.cancel_paper_order(client_order_id) or order
            self._publish_order(canceled)
            return canceled
        raise LiveTradingDisabled(
            "Live ZebPay cancellation is fail-closed because official sources conflict on the "
            "cancellation path. No request was sent; manage existing exchange orders in ZebPay directly."
        )

    def signals(self, symbol: str, timeframe: str = "5m") -> dict[str, Any]:
        symbol = self._allowed_symbol(symbol)
        history = self.get_candles(symbol, timeframe, 90)
        closes = [float(row[4]) for row in history if len(row) > 4 and row[4] > 0]
        if len(closes) < 30:
            baseline = {"bias": "neutral", "fast_sma": None, "slow_sma": None, "spread_pct": 0.0}
        else:
            fast = sum(closes[-10:]) / 10
            slow = sum(closes[-30:]) / 30
            spread = ((fast / slow) - 1) * 100 if slow else 0.0
            baseline = {
                "bias": "bullish" if spread > 0.05 else "bearish" if spread < -0.05 else "neutral",
                "fast_sma": fast,
                "slow_sma": slow,
                "spread_pct": round(spread, 4),
            }
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "source": "SMA 10/30 research indicator",
            "signal": baseline,
            "kronos": self.kronos.status,
            "automated_execution": False,
            "disclaimer": "Signals are for research only and do not place or recommend orders.",
        }

    def forecast(self, symbol: str, timeframe: str = "5m") -> dict[str, Any]:
        symbol = self._allowed_symbol(symbol)
        if not self.kronos.enabled:
            return {
                "available": False,
                "message": "Kronos model inference is disabled in the server configuration.",
            }
        history = self.get_candles(symbol, timeframe, min(300, max(50, self.kronos.lookback)))
        return self.kronos.forecast(symbol, timeframe, history, pred_len=self.kronos.default_pred_len)

    def _match_paper_orders(self, symbol: str, quote: dict[str, Any]) -> None:
        for order in self.store.list_orders("paper", symbol, limit=500):
            if order["status"] == "open":
                self._match_one_paper_order(order, quote)

    def _match_one_paper_order(self, order: dict[str, Any], quote: dict[str, Any]) -> None:
        # Paper mode may use a public ZebPay quote, but the fill is always local simulation.
        bid = _decimal_or_none(quote.get("bid"))
        ask = _decimal_or_none(quote.get("ask"))
        price = Decimal(order["price"])
        fill_price = None
        if order["side"] == "buy" and ask is not None and price >= ask:
            fill_price = ask
        elif order["side"] == "sell" and bid is not None and price <= bid:
            fill_price = bid
        if fill_price is not None:
            filled_order = self.store.fill_paper_order(order["client_order_id"], fill_price)
            if filled_order and filled_order["status"] == "filled":
                position = self.positions.apply_fill(
                    trade_id=f"paper:{order['client_order_id']}",
                    client_order_id=order["client_order_id"],
                    exchange_order_id=None,
                    symbol=order["symbol"],
                    side=order["side"],
                    amount=Decimal(order["amount"]),
                    price=Decimal(filled_order["price"]),
                )
                if position is not None:
                    self._record_realized_fill(position)
                    if self.events is not None:
                        self.events.publish("position_update", position)
                    self._publish_order(filled_order)

    def _record_realized_fill(self, position: dict[str, Any]) -> None:
        if self.strategy_risk is None or position.get("duplicate"):
            return
        realized = Decimal(str(position.get("fill_realized_pnl", "0")))
        if realized != 0:
            self.strategy_risk.record_trade(realized)

    def _publish_order(self, order: dict[str, Any]) -> None:
        if self.events is not None:
            self.events.publish("order_update", order)

    def _validate_tracked_sell(self, symbol: str, side: str, amount: Decimal) -> None:
        if side != "sell":
            return
        position = self.positions.get_position(symbol)
        tracked_amount = Decimal(str(position["amount"])) if position else Decimal("0")
        if amount > tracked_amount:
            raise RiskViolation(
                f"Sell size exceeds the position tracked by this desk ({decimal_text(tracked_amount)}). "
                "Import/cost-basis reconciliation for externally acquired assets is not enabled."
            )

    def _allowed_symbol(self, symbol: str) -> str:
        normalized = normalize_symbol(symbol)
        if normalized not in self.settings.allowed_symbols:
            raise RiskViolation("This market is not in the server-side allowlist")
        return normalized


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() else None
    except Exception:
        return None


def _status(value: Any, default: str = "open") -> str:
    status = str(value or default).strip().lower().replace("cancelled", "canceled")
    if status == "partially_filled":
        return "partially_filled"
    if status in {"new", "active", "pending", "open"}:
        return "open"
    if status in {"filled", "closed", "completed"}:
        return "filled"
    if status in {"canceled", "cancel", "rejected", "expired"}:
        return "canceled"
    if status in {"failed", "unknown", "submitting"}:
        return status
    return default
