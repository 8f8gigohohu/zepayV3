from __future__ import annotations

import logging
import math
import threading
import time
from decimal import Decimal
from typing import Any

from .config import Settings
from .utils import decimal_text, normalize_symbol


logger = logging.getLogger("zepay.exchange")


class ExchangeGatewayError(RuntimeError):
    pass


class ExchangeUnavailable(ExchangeGatewayError):
    pass


class ExchangeGateway:
    """Thin CCXT-backed adapter for ZebPay Spot REST endpoints.

    The CCXT ZebPay implementation handles ZebPay's signing, endpoint paths, and
    exchange precision. Public and credentialed clients are kept separate so a
    public market-data call can never accidentally use private API credentials.
    """

    def __init__(
        self,
        settings: Settings,
        client_factory: Any | None = None,
        rate_limit_ms: int = 1000,
        max_retries: int = 3,
        circuit_threshold: int = 5,
        circuit_reset_seconds: float = 30.0,
    ):
        self.settings = settings
        self.rate_limit_ms = max(50, int(rate_limit_ms))
        self.max_retries = max(0, min(int(max_retries), 4))
        self.circuit_threshold = max(1, int(circuit_threshold))
        self.circuit_reset_seconds = max(1.0, float(circuit_reset_seconds))
        self._client_factory = client_factory
        self._clients: dict[str, Any] = {}
        self._markets_loaded: set[str] = set()
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0
        self._lock = threading.RLock()

    def _build_client(self, private: bool) -> Any:
        if self._client_factory is not None:
            return self._client_factory(private)
        try:
            import ccxt
        except ImportError as exc:
            raise ExchangeUnavailable("CCXT is missing; install requirements.txt") from exc
        if not hasattr(ccxt, "zebpay"):
            raise ExchangeUnavailable("Installed CCXT version does not include the ZebPay adapter")
        config: dict[str, Any] = {
            "enableRateLimit": True,
            "rateLimit": self.rate_limit_ms,
            "timeout": 15_000,
            "options": {
                "defaultType": "spot",
                "fetchMarkets": {"types": ["spot"]},
            },
        }
        if private:
            if not self.settings.has_api_credentials:
                raise ExchangeUnavailable("ZebPay API credentials are not configured on the server")
            config["apiKey"] = self.settings.api_key
            config["secret"] = self.settings.api_secret
        return ccxt.zebpay(config)

    def _client(self, private: bool = False) -> Any:
        key = "private" if private else "public"
        if key not in self._clients:
            self._clients[key] = self._build_client(private)
        client = self._clients[key]
        if key not in self._markets_loaded:
            try:
                self._request("/api/v2/ex/exchangeInfo", client, client.load_markets)
            except Exception as exc:  # CCXT has several transport and exchange error classes.
                raise self._read_error(exc) from exc
            self._markets_loaded.add(key)
        return client

    def _read_error(self, exc: Exception) -> ExchangeUnavailable:
        text = str(exc) or exc.__class__.__name__
        for secret in (self.settings.api_key, self.settings.api_secret):
            if secret:
                text = text.replace(secret, "[redacted]")
        return ExchangeUnavailable(text[:400])

    def _request(self, endpoint: str, client: Any, operation: Any, *, retryable: bool = True) -> Any:
        now = time.monotonic()
        if now < self._circuit_open_until:
            remaining = max(1, int(self._circuit_open_until - now))
            raise ExchangeUnavailable(f"ZebPay circuit breaker is open; retry after {remaining} seconds")

        attempts = self.max_retries + 1 if retryable else 1
        for attempt in range(attempts):
            started = time.perf_counter()
            try:
                result = operation()
                status = getattr(client, "last_http_response_code", None) or 200
                logger.info(
                    "exchange_request endpoint=%s response_code=%s latency_ms=%.1f attempt=%s",
                    endpoint,
                    status,
                    (time.perf_counter() - started) * 1000,
                    attempt + 1,
                )
                self._consecutive_failures = 0
                self._circuit_open_until = 0.0
                return result
            except Exception as exc:
                status = getattr(client, "last_http_response_code", None) or getattr(getattr(exc, "response", None), "status_code", None) or "error"
                transient = self._is_transient_error(exc)
                logger.warning(
                    "exchange_request endpoint=%s response_code=%s latency_ms=%.1f attempt=%s error_type=%s",
                    endpoint,
                    status,
                    (time.perf_counter() - started) * 1000,
                    attempt + 1,
                    exc.__class__.__name__,
                )
                self._consecutive_failures += 1
                if self._consecutive_failures >= self.circuit_threshold:
                    self._circuit_open_until = time.monotonic() + self.circuit_reset_seconds
                    logger.error(
                        "exchange_circuit_open failures=%s reset_seconds=%.1f",
                        self._consecutive_failures,
                        self.circuit_reset_seconds,
                    )
                if not retryable or not transient or attempt + 1 >= attempts:
                    raise
                time.sleep(min(4.0, 0.25 * (2 ** attempt)))
        raise ExchangeUnavailable("Exchange request attempts exhausted")

    @staticmethod
    def _is_transient_error(exc: Exception) -> bool:
        try:
            import ccxt
            transient_types = tuple(
                candidate for name in (
                    "NetworkError", "RequestTimeout", "ExchangeNotAvailable",
                    "RateLimitExceeded", "DDoSProtection",
                )
                if isinstance((candidate := getattr(ccxt, name, None)), type)
            )
            return bool(transient_types) and isinstance(exc, transient_types)
        except ImportError:
            return isinstance(exc, (TimeoutError, ConnectionError))

    def ticker(self, symbol: str) -> dict[str, Any]:
        symbol = normalize_symbol(symbol)
        with self._lock:
            client = self._client()
            try:
                ticker = self._request("/api/v2/market/ticker", client, lambda: client.fetch_ticker(symbol))
            except Exception as exc:
                raise self._read_error(exc) from exc
        info = ticker.get("info") if isinstance(ticker.get("info"), dict) else {}
        return {
            "symbol": symbol,
            "last": _number(ticker.get("last") or info.get("last")),
            "bid": _number(ticker.get("bid") or info.get("bestBid") or info.get("bid")),
            "ask": _number(ticker.get("ask") or info.get("bestAsk") or info.get("ask")),
            "high": _number(ticker.get("high") or info.get("high")),
            "low": _number(ticker.get("low") or info.get("low")),
            "percentage": _number(ticker.get("percentage") or info.get("priceChangePercent")),
            "base_volume": _number(ticker.get("baseVolume") or info.get("vol")),
            "timestamp": ticker.get("timestamp") or info.get("timestamp") or info.get("ts") or int(time.time() * 1000),
            "source": "zebpay",
            "is_simulated": False,
        }

    def candles(self, symbol: str, timeframe: str, limit: int) -> list[list[float]]:
        symbol = normalize_symbol(symbol)
        duration_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000,
                       "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}.get(timeframe)
        if duration_ms is None:
            raise ValueError(f"Unsupported timeframe: {timeframe}")
        now_ms = int(time.time() * 1000)
        since = now_ms - (limit + 2) * duration_ms
        with self._lock:
            client = self._client()
            try:
                raw = self._request(
                    "/api/v2/market/klines",
                    client,
                    lambda: client.fetch_ohlcv(
                        symbol,
                        timeframe=timeframe,
                        since=since,
                        limit=limit,
                        params={"until": now_ms},
                    ),
                )
            except Exception as exc:
                raise self._read_error(exc) from exc
        return [[float(value or 0) for value in candle[:6]] for candle in raw]

    def order_book(self, symbol: str, limit: int = 100) -> dict[str, Any]:
        normalized = normalize_symbol(symbol)
        with self._lock:
            client = self._client()
            try:
                return self._request(
                    "/api/v2/market/orderbook",
                    client,
                    lambda: client.fetch_order_book(normalized, limit=limit),
                )
            except Exception as exc:
                raise self._read_error(exc) from exc

    def recent_trades(self, symbol: str, limit: int = 100) -> list[dict[str, Any]]:
        normalized = normalize_symbol(symbol)
        with self._lock:
            client = self._client()
            try:
                return self._request(
                    "/api/v2/market/trades",
                    client,
                    lambda: client.fetch_trades(normalized, limit=limit),
                )
            except Exception as exc:
                raise self._read_error(exc) from exc

    def market(self, symbol: str) -> dict[str, Any]:
        symbol = normalize_symbol(symbol)
        with self._lock:
            client = self._client()
            try:
                market = client.market(symbol)
            except Exception as exc:
                raise self._read_error(exc) from exc
        limits = market.get("limits") or {}
        amount_limits = limits.get("amount") or {}
        cost_limits = limits.get("cost") or {}
        info = market.get("info") if isinstance(market.get("info"), dict) else {}
        active = market.get("active")
        if active is None:
            status = str(info.get("status", "open")).lower()
            active = info.get("enableTrading", True) is not False and status in {"open", "trading", "active"}
        return {
            "symbol": symbol,
            "active": active,
            "base": market.get("base"),
            "quote": market.get("quote"),
            "minimum_amount": _number(
                amount_limits.get("min") or info.get("minOrderSize") or info.get("baseMinSize") or info.get("lotSz")
            ),
            "minimum_notional": _number(
                cost_limits.get("min") or info.get("minNotional") or info.get("quoteMinSize")
            ),
            "amount_precision": market.get("precision", {}).get("amount"),
            "price_precision": market.get("precision", {}).get("price"),
        }

    def normalize_order(self, symbol: str, amount: Decimal, price: Decimal) -> tuple[Decimal, Decimal]:
        with self._lock:
            client = self._client(private=True)
            try:
                normalized_amount = client.amount_to_precision(symbol, decimal_text(amount))
                normalized_price = client.price_to_precision(symbol, decimal_text(price))
            except Exception as exc:
                raise self._read_error(exc) from exc
        return Decimal(normalized_amount), Decimal(normalized_price)

    def balance(self) -> dict[str, dict[str, Decimal]]:
        with self._lock:
            client = self._client(private=True)
            try:
                raw = self._request("/api/v2/account/balance", client, client.fetch_balance)
            except Exception as exc:
                raise self._read_error(exc) from exc
        result: dict[str, dict[str, Decimal]] = {}
        currencies = set((raw.get("free") or {}).keys()) | set((raw.get("used") or {}).keys()) | set((raw.get("total") or {}).keys())
        for currency in currencies:
            result[str(currency).upper()] = {
                "free": _decimal((raw.get("free") or {}).get(currency)),
                "used": _decimal((raw.get("used") or {}).get(currency)),
                "total": _decimal((raw.get("total") or {}).get(currency)),
            }
        return result

    def test_connection(self, symbol: str = "BTC/INR") -> dict[str, Any]:
        """Verify public market access and signed private reads; never submits an order."""
        normalized = normalize_symbol(symbol)
        tested_at = int(time.time() * 1000)
        try:
            self.ticker(normalized)
            market_data: dict[str, Any] = {"ok": True, "symbol": normalized, "source": "zebpay"}
        except Exception as exc:
            safe_error = self._read_error(exc)
            market_data = {"ok": False, "symbol": normalized, "error": str(safe_error)[:180]}

        try:
            balances = self.balance()
            private_account: dict[str, Any] = {"ok": True, "assets_returned": len(balances)}
        except Exception as exc:
            safe_error = self._read_error(exc)
            private_account = {"ok": False, "error": str(safe_error)[:180]}

        return {
            "ok": bool(market_data["ok"] and private_account["ok"]),
            "tested_at": tested_at,
            "market_data": market_data,
            "private_account": private_account,
            "orders_submitted": 0,
        }

    def update_settings(self, settings: Settings) -> None:
        """Apply credential rotation and discard cached clients holding old keys."""
        with self._lock:
            self.settings = settings
            self._clients.clear()
            self._markets_loaded.clear()
            self._consecutive_failures = 0
            self._circuit_open_until = 0.0

    def place_limit_order(self, symbol: str, side: str, amount: Decimal, price: Decimal, client_order_id: str) -> dict[str, Any]:
        """ZebPay live writes are intentionally disabled pending an authoritative contract."""
        raise ExchangeUnavailable(
            "ZebPay live order placement is disabled: official docs and clients conflict on order "
            "fields (amount/quantity, quoteOrderAmount/quoteOrderQty, stopLossPrice/stopPrice). "
            "No request is sent."
        )

    def cancel_order(self, exchange_order_id: str, symbol: str) -> dict[str, Any]:
        """Refuse exchange cancellation until the official endpoint path is confirmed."""
        raise ExchangeUnavailable(
            "ZebPay live cancellation is disabled: official sources conflict on the cancel path. "
            "No request is sent; manage any existing exchange order in ZebPay directly."
        )

    def fetch_order(self, exchange_order_id: str, symbol: str) -> dict[str, Any]:
        with self._lock:
            client = self._client(private=True)
            try:
                return self._request(
                    "/api/v2/ex/order",
                    client,
                    lambda: client.fetch_order(str(exchange_order_id), normalize_symbol(symbol)),
                )
            except Exception as exc:
                raise self._read_error(exc) from exc

    def open_orders(self, symbol: str) -> list[dict[str, Any]]:
        with self._lock:
            client = self._client(private=True)
            try:
                return self._request(
                    "/api/v2/ex/orders",
                    client,
                    lambda: client.fetch_open_orders(normalize_symbol(symbol)),
                )
            except Exception as exc:
                raise self._read_error(exc) from exc


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _decimal(value: Any) -> Decimal:
    if value is None or value == "":
        return Decimal(0)
    try:
        number = Decimal(str(value))
        return number if number.is_finite() else Decimal(0)
    except Exception:
        return Decimal(0)
