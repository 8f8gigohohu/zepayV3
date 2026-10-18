"""ZebPay Spot adapter.

Public market data - implemented from the official Spot reference. The uploaded
archive contains a prior-deployment live-check report, but that evidence is not
assumed to apply to this environment. Runtime status starts unverified and is
promoted only after this process gets a successful response from the official host:
https://sapi.zebpay.com/api/v2:
  - GET /market/allTickers                 (200, requires browser-like User-Agent)
  - GET /market/klines  (startTime+endTime REQUIRED, in epoch SECONDS; returns
    Binance-style arrays; units clarified by live probing, docs were ambiguous)
  - GET /market/orderbook?symbol=...       (200)
  - GET /market/trades?symbol=...          (200, id/side/amount/price/timestamp/isBuyerMaker)
Docs: https://github.com/zebpay/zebpay-api-references (official per apidocs.zebpay.com).

Private (authenticated) READ-ONLY endpoints - implemented from the official
reference client, not guessed:
  The official Spot Node client (spot/clients/rest-http/node/utils/auth.js) is the
  only place the signing canonicalisation is actually written down:
    * timestamp  = Date.now()  -> epoch MILLISECONDS, appended last
    * GET        -> sign the query string exactly as sent:
                    encodeURIComponent(key)=encodeURIComponent(value) joined by '&'
    * signature  = HMAC-SHA256(secret, that string), lowercase hex
    * headers    = x-auth-apikey / x-auth-signature
  The uploaded archive reports a prior live probe of these headers. That probe is
  historical source evidence only; this deployment must establish its own reachability.
  The docs' GET example shows a 10-digit (seconds) timestamp, which contradicts
  the client; the adapter signs in millis and retries ONCE in seconds only when
  the server answers with the documented "expired timestamp" error (code 2003).
  See docs/ZEBPAY-API-ASSESSMENT.md for the evidence table.

NOT IMPLEMENTED - order placement/cancellation:
  The official docs contradict themselves and the reference clients on the exact
  request contract (body `amount`/`quoteOrderAmount`/`stopLossPrice` on the
  private-endpoints page vs `quantity`/`quoteOrderQty`/`stopPrice` everywhere
  else; cancel/details as `DELETE|GET /ex/order?orderId=` vs `/ex/orders/{id}`),
  `price` is marked required for every order type, and no sandbox exists. An
  order placed through a wrong field name is an uninsured trading action, so
  place_order/cancel_order refuse by construction until ZebPay confirms the
  contract. There is also no public spot WebSocket documented.
"""
import hashlib
import hmac
import json
import urllib.parse
from typing import Any, Callable

from ..models import ExchangeCredential
from ..security import decrypt_secret
from . import http
from .base import Capability, CapabilityStatus, Envelope, Kline, Level, OrderBook, Ticker, Trade, now_ms

EXCHANGE = "zebpay"

# ZebPay klines intervals per official public-endpoints reference.
INTERVAL_ALT: dict[str, str] = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "1d": "1d",
}

# Documented error codes (spot/api-reference/error-handling.md).
ERROR_CODES: dict[int, str] = {
    2000: "authentication failed",
    2001: "invalid API key",
    2002: "invalid signature",
    2003: "expired timestamp",
    3000: "insufficient balance",
    4000: "rate limit exceeded",
}


# ----- signing (pure, unit-tested) ------------------------------------------
def encode_component(value: Any) -> str:
    """Match JavaScript encodeURIComponent(), which is what the official client uses.

    Python's quote() leaves ``-._~`` unescaped and escapes ``!*'()``; JS does the
    opposite for those four characters. Escaping differently than the client
    would produce a different string-to-sign for inputs containing them.
    """
    return urllib.parse.quote(str(value), safe="!*'()")


def build_query(params: dict[str, Any], timestamp: int) -> str:
    """Canonical string-to-sign: caller's params in order, timestamp last."""
    ordered = {**params, "timestamp": timestamp}
    return "&".join(f"{encode_component(k)}={encode_component(v)}" for k, v in ordered.items())


def sign_query(api_key: str, api_secret: str, params: dict[str, Any],
               timestamp: int) -> tuple[str, dict[str, str]]:
    """Return (query_string, headers). The query string is sent verbatim so the
    bytes the server hashes are exactly the bytes we signed (no re-encoding)."""
    query = build_query(params, timestamp)
    signature = hmac.new(api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    return query, {"x-auth-apikey": api_key, "x-auth-signature": signature}


def timestamp_for(unit: str) -> int:
    ts = now_ms()
    return ts if unit == "ms" else ts // 1000


def describe_upstream(err: http.UpstreamError) -> tuple[str, bool]:
    """Translate ZebPay's documented error body into a readable reason.

    Returns (description, is_timestamp_rejection) so callers can decide whether a
    retry with the other documented timestamp unit is warranted.
    """
    try:
        body = json.loads(err.body)
    except (ValueError, TypeError):
        return f"HTTP {err.status}: {str(err.body)[:160]}", False
    code = body.get("statusCode") if isinstance(body, dict) else None
    if code is None and isinstance(body, dict):
        code = body.get("code")
    message = ""
    if isinstance(body, dict):
        message = str(body.get("statusDescription") or body.get("message") or "")
    label = ERROR_CODES.get(int(code)) if isinstance(code, int) else None
    parts = [f"HTTP {err.status}"]
    if code is not None:
        parts.append(f"statusCode {code}")
    if label:
        parts.append(label)
    if message and message.lower() not in ("error description", ""):
        parts.append(message)
    return " - ".join(parts), int(code) == 2003 if isinstance(code, int) else False


class ZebPayAdapter:
    exchange = EXCHANGE

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self._official_upstream = urllib.parse.urlsplit(self.base).hostname == "sapi.zebpay.com"
        self._public_live_verified = False

    def _record_public_success(self) -> None:
        # A fixture, mock server, or alternate base URL must not inherit another
        # deployment's live-verification claim.
        if self._official_upstream:
            self._public_live_verified = True

    @property
    def capabilities(self) -> dict[str, Capability]:
        public_status = (CapabilityStatus.VERIFIED_LIVE if self._public_live_verified
                         else CapabilityStatus.NEEDS_VERIFICATION)
        public_detail = (
            "a successful public read from the official ZebPay host was observed by this process"
            if self._public_live_verified else
            "implemented from the official Spot reference; this environment has not yet observed a "
            "successful read from the official host"
        )
        return {
            "public_market_data": Capability(public_status, public_detail),
            "websocket_market_data": Capability(CapabilityStatus.UNSUPPORTED,
                                                "no public spot WebSocket documented"),
            "account_balances": Capability(CapabilityStatus.VERIFIED_DOCS,
                                           "signed GET /api/v2/account/balance implemented from the "
                                           "official Spot client's canonical scheme (HMAC-SHA256, ms "
                                           "timestamp, x-auth-apikey/x-auth-signature); this environment "
                                           "has not verified a real account read"),
            "place_order": Capability(CapabilityStatus.NOT_IMPLEMENTED,
                                      "docs contradict each other and the official clients on the order "
                                      "body (amount vs quantity, quoteOrderAmount vs quoteOrderQty) - "
                                      "see docs/ZEBPAY-API-ASSESSMENT.md"),
            "cancel_order": Capability(CapabilityStatus.NOT_IMPLEMENTED,
                                       "docs disagree on the path (/ex/order?orderId= vs /ex/orders/{id})"),
            "order_history": Capability(CapabilityStatus.VERIFIED_DOCS,
                                        "signed GET /api/v2/ex/orders (symbol required) implemented "
                                        "read-only; not exercised live (no credentials)"),
            "derivatives": Capability(CapabilityStatus.NOT_IMPLEMENTED,
                                      "futures API is separate (futuresbe.zebpay.com); spot-first policy"),
        }

    # ----- helpers ----------------------------------------------------------
    @staticmethod
    def _f(v) -> float | None:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f

    # ----- public market data ----------------------------------------------
    async def ping(self) -> bool:
        raw = await http.get_json(f"{self.base}/api/v2/market/allTickers")
        items = raw.get("data", raw) if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            raise ValueError("unexpected allTickers payload shape")
        self._record_public_success()
        return True

    async def tickers(self, symbol: str | None = None) -> Envelope:
        raw = await http.get_json(f"{self.base}/api/v2/market/allTickers")
        items = raw["data"] if isinstance(raw, dict) and "data" in raw else raw
        out = []
        for t in items:
            if symbol and t["symbol"] != symbol:
                continue
            out.append(Ticker(
                symbol=t["symbol"], last=self._f(t["last"]),
                bid=self._f(t.get("bid")), ask=self._f(t.get("ask")),
                high=self._f(t.get("high")), low=self._f(t.get("low")),
                open=self._f(t.get("open")), change_pct=self._f(t.get("percentage")),
                base_volume=self._f(t.get("baseVolume")), quote_volume=self._f(t.get("quoteVolume")),
                ts_ms=int(t["timestamp"]),
            ))
        if symbol and not out:
            raise ValueError(f"unknown symbol {symbol!r} for zebpay")
        self._record_public_success()
        up = max((t.ts_ms for t in out), default=None)
        return self._env("GET /api/v2/market/allTickers" + (f" (filtered {symbol})" if symbol else ""),
                         out, up, stale_after_ms=5_000)

    async def klines(self, symbol: str, interval: str, start_ms: int | None = None,
                     end_ms: int | None = None, limit: int = 300) -> Envelope:
        """Use startTime/endTime in epoch SECONDS as reported by the imported
        archive's prior deployment probe. Treat that unit as unverified here until
        the official endpoint returns a successful response in this process.
        Returns Binance-style arrays [open_time_s, open, high, low, close, volume,
        close_time_s]."""
        if interval not in INTERVAL_ALT:
            raise ValueError(f"zebpay supports intervals {sorted(INTERVAL_ALT)}")
        # Official API requires both; emulate a lookback window consistent with the request.
        step = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
                "1h": 3_600_000, "1d": 86_400_000}[interval]
        end_ms = end_ms or now_ms()
        start_ms = start_ms or (end_ms - min(limit, 500) * step)
        raw = await http.get_json(f"{self.base}/api/v2/market/klines", {
            "symbol": symbol, "interval": interval,
            # the API expects epoch seconds
            "startTime": start_ms // 1000, "endTime": end_ms // 1000,
        })
        rows = raw["data"] if isinstance(raw, dict) and "data" in raw else raw
        if not isinstance(rows, list):
            raise ValueError("unexpected klines payload shape")
        data = [Kline(int(row[0]) * 1000, float(row[1]), float(row[2]), float(row[3]),
                      float(row[4]), float(row[5]), int(row[6]) * 1000) for row in rows]
        self._record_public_success()
        up = data[-1].close_time_ms if data else None
        return self._env(f"GET /api/v2/market/klines?symbol={symbol}&interval={interval}", data, up,
                         stale_after_ms=600_000 if "1d" == interval else 120_000)

    async def orderbook(self, symbol: str, limit: int = 25) -> Envelope:
        raw = await http.get_json(f"{self.base}/api/v2/market/orderbook", {"symbol": symbol})
        d = raw["data"]
        bids = [Level(self._f(b[0]), self._f(b[1])) for b in (d.get("bids") or [])[:limit]]
        asks = [Level(self._f(a[0]), self._f(a[1])) for a in (d.get("asks") or [])[:limit]]
        self._record_public_success()
        ob = OrderBook(bids=bids, asks=asks, ts_ms=now_ms())
        return self._env(f"GET /api/v2/market/orderbook?symbol={symbol}", ob)

    async def trades(self, symbol: str, limit: int = 50) -> Envelope:
        raw = await http.get_json(f"{self.base}/api/v2/market/trades", {"symbol": symbol})
        rows = raw["data"]
        out = [Trade(str(t["id"]), self._f(t["price"]), self._f(t["amount"]),
                     int(t["timestamp"]), t.get("isBuyerMaker") is True or t.get("side") == "buy")
               for t in rows[:limit]]
        self._record_public_success()
        up = max((t.ts_ms for t in out), default=None)
        return self._env(f"GET /api/v2/market/trades?symbol={symbol}&limit={limit}", out, up,
                         stale_after_ms=10_000)

    # ----- private, READ-ONLY ----------------------------------------------
    async def _signed_get(self, cred: ExchangeCredential, path: str, params: dict[str, Any],
                          accept: Callable[[Any], Any], label: str,
                          stale_after_ms: int = 15_000) -> Envelope:
        """Signed GET with ONE documented-ambiguity reconciliation.

        The official docs show a seconds timestamp in the GET example while the
        official client signs `Date.now()` (milliseconds). We sign in milliseconds
        and, only when the server rejects with the documented "expired timestamp"
        code (2003), retry once in seconds. Anything else is surfaced verbatim.
        """
        api_key = decrypt_secret(cred.encrypted_key)
        api_secret = decrypt_secret(cred.encrypted_secret)
        failures: list[str] = []
        for unit in ("ms", "s"):
            query, headers = sign_query(api_key, api_secret, params, timestamp_for(unit))
            try:
                raw = await http.get_json(f"{self.base}{path}?{query}", extra_headers=headers)
            except http.UpstreamError as e:
                desc, timestamp_rejected = describe_upstream(e)
                failures.append(f"{unit} timestamp: {desc}")
                if timestamp_rejected and unit == "ms":
                    continue  # documented unit ambiguity - exactly one retry, in seconds
                break
            payload = raw.get("data") if isinstance(raw, dict) else None
            if payload is None:
                raise ValueError(f"zebpay {path} returned no data: {str(raw)[:160]}")
            data = accept(payload)
            data["timestamp_unit"] = unit
            return self._env(label, data, stale_after_ms=stale_after_ms,
                             verified=CapabilityStatus.VERIFIED_DOCS)
        # Both documented interpretations failed (or the first failure was not a
        # timestamp rejection). Report what the server actually said, per attempt.
        raise http.UpstreamError(401, f"{path} signing failed - " + " | ".join(failures))

    @staticmethod
    def _accept_balances(payload: Any) -> dict[str, Any]:
        rows = payload if isinstance(payload, list) else payload.get("balances", [])
        balances = []
        for b in rows:
            free = float(b.get("free") or 0)
            locked = float(b.get("used") or 0)
            if free <= 0 and locked <= 0:
                continue
            balances.append({
                "asset": b.get("currency"),
                "free": free,
                "locked": locked,
                "total": float(b.get("total") or free + locked),
                "is_fiat": bool(b.get("isFiat")),
            })
        return {"balances": balances, "count": len(balances)}

    @staticmethod
    def _accept_orders(payload: Any) -> dict[str, Any]:
        items = payload.get("items", []) if isinstance(payload, dict) else payload
        orders = []
        for o in items or []:
            orders.append({
                "order_id": o.get("orderId"),
                "symbol": o.get("symbol"),
                "side": o.get("side"),
                "type": o.get("type"),
                "price": o.get("price"),
                "amount": o.get("amount"),
                "filled": o.get("filled"),
                "remaining": o.get("remaining"),
                "status": o.get("status"),
                "time_in_force": o.get("timeInForce"),
                "timestamp": o.get("timestamp"),
            })
        return {"orders": orders, "count": len(orders)}

    async def account(self, cred: ExchangeCredential) -> Envelope:
        """Signed read of the spot wallet balances. Read-only by construction:
        there is no order-submitting code path in this adapter."""
        return await self._signed_get(cred, "/api/v2/account/balance", {},
                                      self._accept_balances,
                                      "GET /api/v2/account/balance (signed, read-only)",
                                      stale_after_ms=60_000)

    async def open_orders(self, cred: ExchangeCredential, symbol: str,
                          status: str = "ACTIVE", page: int = 1,
                          page_size: int = 20) -> Envelope:
        """Signed read of the order list. `symbol` is required by the docs."""
        if status not in ("ACTIVE", "FILLED", "CANCELLED", "PARTIALLY_FILLED"):
            raise ValueError(f"unsupported order status {status!r}")
        if not (1 <= page_size <= 100):
            raise ValueError("page_size must be within 1..100")
        params = {"symbol": symbol, "status": status,
                  "currentPage": page, "pageSize": page_size}
        return await self._signed_get(cred, "/api/v2/ex/orders", params,
                                      self._accept_orders,
                                      f"GET /api/v2/ex/orders?symbol={symbol}&status={status} "
                                      "(signed, read-only)",
                                      stale_after_ms=30_000)

    # ----- private, deliberately refused -----------------------------------
    def place_order(self, *args: Any, **kwargs: Any):
        raise NotImplementedError(
            "zebpay order placement is NOT implemented: the official docs and the official clients "
            "disagree on the order body (amount vs quantity, quoteOrderAmount vs quoteOrderQty, "
            "stopLossPrice vs stopPrice) and mark price required for every order type. Sending a "
            "guessed body would be an uninsured trading action. See docs/ZEBPAY-API-ASSESSMENT.md."
        )

    def cancel_order(self, *args: Any, **kwargs: Any):
        raise NotImplementedError(
            "zebpay order cancellation is NOT implemented: the docs disagree on the path "
            "(DELETE /api/v2/ex/order?orderId= vs DELETE /api/v2/ex/orders/{orderId})."
        )

    def _env(self, endpoint: str, data: Any, upstream_ts_ms: int | None = None,
             stale_after_ms: int = 15_000,
             verified: CapabilityStatus | None = None) -> Envelope:
        if verified is None:
            verified = (CapabilityStatus.VERIFIED_LIVE if self._public_live_verified
                        else CapabilityStatus.VERIFIED_DOCS)
        return Envelope(exchange=self.exchange, endpoint=endpoint, source_url=self.base,
                        ts_ms=now_ms(), stale_after_ms=stale_after_ms, data=data,
                        upstream_ts_ms=upstream_ts_ms, verified=verified)
