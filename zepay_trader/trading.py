from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from .config import Settings
from .demo_market import TIMEFRAME_MS, candles as demo_candles, ticker as demo_ticker
from .exchange import ExchangeGateway, ExchangeUnavailable, SubmissionUncertain
from .kronos import KronosAdapter
from .risk import RiskManager, RiskViolation, ValidatedOrder
from .schemas import LimitOrderRequest
from .storage import Store
from .utils import decimal_text, normalize_symbol, split_symbol


LIVE_CONFIRMATION_PHRASE = "I UNDERSTAND THIS IS A LIVE ORDER"


class LiveTradingDisabled(RuntimeError):
    pass


class OperatorAuthenticationRequired(RuntimeError):
    pass


class TradingService:
    def __init__(self, settings: Settings, gateway: ExchangeGateway, store: Store, kronos: KronosAdapter):
        self.settings = settings
        self.gateway = gateway
        self.store = store
        self.kronos = kronos
        self.risk = RiskManager(settings, store)
        self._order_lock = threading.RLock()

    def get_market(self, symbol: str) -> dict[str, Any]:
        symbol = self._allowed_symbol(symbol)
        try:
            quote = self.gateway.ticker(symbol)
        except ExchangeUnavailable:
            if self.settings.trading_mode == "live":
                raise
            quote = demo_ticker(symbol)
        if not quote.get("last"):
            if self.settings.trading_mode == "live":
                raise ExchangeUnavailable("ZebPay did not return a usable last price")
            quote = demo_ticker(symbol)
        if self.settings.trading_mode == "paper":
            self._match_paper_orders(symbol, quote)
        return quote

    def get_candles(self, symbol: str, timeframe: str = "5m", limit: int = 120) -> list[list[float]]:
        symbol = self._allowed_symbol(symbol)
        if timeframe not in TIMEFRAME_MS:
            raise ValueError("Unsupported timeframe")
        limit = max(20, min(int(limit), 300))
        try:
            result = self.gateway.candles(symbol, timeframe, limit)
            if result:
                return result[-limit:]
            raise ExchangeUnavailable("ZebPay returned no candles")
        except ExchangeUnavailable:
            if self.settings.trading_mode == "live":
                raise
            return demo_candles(symbol, timeframe, limit)

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
                if order["status"] != "open" or not order.get("exchange_order_id"):
                    continue
                try:
                    remote = self.gateway.fetch_order(order["exchange_order_id"], order["symbol"])
                    self.store.update_order(
                        order["client_order_id"],
                        status=_status(remote.get("status"), default="open"),
                        filled=remote.get("filled") or 0,
                        raw=remote,
                    )
                except ExchangeUnavailable:
                    # Retain the last known state; transient read failures must not mutate orders.
                    pass
            orders = self.store.list_orders(self.settings.trading_mode, normalized)
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

    def _place_paper_order(self, request: LimitOrderRequest, symbol: str) -> dict[str, Any]:
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
        self._match_one_paper_order(order, quote)
        return self.store.get_order(client_id) or order

    def _place_live_order(
        self,
        request: LimitOrderRequest,
        symbol: str,
        operator_authenticated: bool,
    ) -> dict[str, Any]:
        if not self.settings.live_ready:
            raise LiveTradingDisabled(
                "Live trading is locked. Configure TRADING_MODE=live, LIVE_TRADING_ENABLED=true, "
                "server-side ZebPay keys, an APP_PASSWORD of at least 12 characters, and SECURE_COOKIE=true."
            )
        if not operator_authenticated:
            raise OperatorAuthenticationRequired("Sign in to the trading desk before using live account actions")
        if request.live_confirmation != LIVE_CONFIRMATION_PHRASE:
            raise RiskViolation("Live orders require the exact per-order confirmation phrase")

        # Live orders fail closed: no demo prices, no stale/fallback quote, no automatic retry.
        ticker = self.gateway.ticker(symbol)
        market = self.gateway.market(symbol)
        amount, price = self.gateway.normalize_order(symbol, request.amount, request.price)
        if amount <= 0 or price <= 0:
            raise RiskViolation("Order is below ZebPay's supported precision")
        if amount != request.amount or price != request.price:
            raise RiskViolation(
                "Order does not match ZebPay precision; adjust the amount/price to "
                f"{decimal_text(amount)} {symbol.split('/')[0]} at {decimal_text(price)} INR"
            )

        deviation = self.settings.max_price_deviation_pct
        ask = _decimal_or_none(ticker.get("ask"))
        bid = _decimal_or_none(ticker.get("bid"))
        reference = ask if request.side == "buy" else bid
        if reference is None or reference <= 0:
            raise RiskViolation(f"ZebPay did not return a valid best {request.side} quote; live order blocked")
        if request.side == "buy" and price > reference * (Decimal(1) + deviation):
            raise RiskViolation(
                f"Buy limit is more than {deviation * 100}% above the current ask; price-band guard blocked it"
            )
        if request.side == "sell" and price < reference * (Decimal(1) - deviation):
            raise RiskViolation(
                f"Sell limit is more than {deviation * 100}% below the current bid; price-band guard blocked it"
            )

        validated = self.risk.validate(symbol, request.side, amount, price, market)
        balance_snapshot = self.gateway.balance()
        free = {asset: item["free"] for asset, item in balance_snapshot.items()}
        self.risk.check_balance(validated, free)

        client_id = f"Z3-{uuid.uuid4().hex[:24]}"
        # Persist before sending. A timeout after submission is marked unknown to avoid duplicate orders.
        pending = self.store.create_order({
            "client_order_id": client_id,
            "mode": "live",
            "symbol": symbol,
            "side": validated.side,
            "order_type": "limit",
            "amount": validated.amount,
            "price": validated.price,
            "filled": Decimal(0),
            "status": "submitting",
            "raw": {},
        })
        try:
            result = self.gateway.place_limit_order(
                symbol, validated.side, validated.amount, validated.price, client_id
            )
        except SubmissionUncertain as exc:
            self.store.update_order(client_id, status="unknown", raw={"error": str(exc)[:300]})
            raise
        except Exception as exc:
            self.store.update_order(client_id, status="failed", raw={"error": str(exc)[:300]})
            raise

        info = result.get("info") if isinstance(result.get("info"), dict) else {}
        exchange_id = result.get("id") or info.get("orderId")
        if exchange_id is None:
            self.store.update_order(
                client_id,
                status="unknown",
                raw={"response": result, "warning": "No exchange order id in response; reconcile manually"},
            )
            raise SubmissionUncertain(
                "ZebPay response did not include an order id. Check the ZebPay open orders before retrying."
            )
        updated = self.store.update_order(
            client_id,
            exchange_order_id=str(exchange_id),
            status=_status(result.get("status"), default="open"),
            filled=result.get("filled") or 0,
            raw={"response": result},
        )
        return updated or pending

    def cancel_order(self, client_order_id: str, symbol: str | None = None) -> dict[str, Any]:
        order = self.store.get_order(client_order_id)
        if order is None or order["mode"] != self.settings.trading_mode:
            raise ValueError("Order not found in this trading desk")
        if symbol and normalize_symbol(symbol) != order["symbol"]:
            raise ValueError("Order symbol does not match")
        if order["status"] != "open":
            raise RiskViolation(f"Only open orders can be canceled (current state: {order['status']})")

        if self.settings.trading_mode == "paper":
            return self.store.cancel_paper_order(client_order_id) or order
        if not self.settings.live_ready:
            raise LiveTradingDisabled("Live trading is not armed")
        if not order.get("exchange_order_id"):
            raise RiskViolation("This order has no exchange id and cannot be safely canceled from here")
        result = self.gateway.cancel_order(order["exchange_order_id"], order["symbol"])
        status = _status(result.get("status"), default="canceled")
        return self.store.update_order(client_order_id, status=status, raw={"response": result}) or order

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
        if not self.kronos.settings.kronos_enabled:
            return {
                "available": False,
                "message": "Kronos is disabled. Configure KRONOS_ENABLED and install its optional requirements.",
            }
        history = self.get_candles(symbol, timeframe, min(300, max(50, self.settings.kronos_lookback)))
        return self.kronos.forecast(symbol, timeframe, history)

    def _match_paper_orders(self, symbol: str, quote: dict[str, Any]) -> None:
        for order in self.store.list_orders("paper", symbol, limit=500):
            if order["status"] == "open":
                self._match_one_paper_order(order, quote)

    def _match_one_paper_order(self, order: dict[str, Any], quote: dict[str, Any]) -> None:
        # Paper mode may use a public ZebPay quote, but the fill is always local simulation.
        bid = _decimal_or_none(quote.get("bid"))
        ask = _decimal_or_none(quote.get("ask"))
        price = Decimal(order["price"])
        if order["side"] == "buy" and ask is not None and price >= ask:
            self.store.fill_paper_order(order["client_order_id"], ask)
        elif order["side"] == "sell" and bid is not None and price <= bid:
            self.store.fill_paper_order(order["client_order_id"], bid)

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
    if status in {"new", "active", "pending", "partially_filled", "open"}:
        return "open"
    if status in {"filled", "closed", "completed"}:
        return "filled"
    if status in {"canceled", "cancel", "rejected", "expired"}:
        return "canceled"
    if status in {"failed", "unknown", "submitting"}:
        return status
    return default
