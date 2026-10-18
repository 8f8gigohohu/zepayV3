"""Binance Spot adapter.

Public endpoints are implemented per the official docs. The uploaded archive
contains a prior-deployment live-check report for data-api.binance.vision; this
copy does not inherit that deployment's evidence. Runtime status is promoted only
after a successful response from an official Binance host in this process.

Private (signed) endpoints use the documented scheme: HMAC-SHA256 over the query
string with the secret, API key in the X-MBX-APIKEY header, timestamp+recvWindow
params. Status: VERIFIED_DOCS (scheme implemented and unit-tested against the
docs' signing description; live private connectivity is NEEDS_VERIFICATION until
this process completes a real signed account read.
"""
import hashlib
import hmac
import urllib.parse
from typing import Any

from ..models import ExchangeCredential
from . import http
from .base import (
    INTERVAL_MS,
    Capability,
    CapabilityStatus,
    Envelope,
    Kline,
    Level,
    OrderBook,
    Ticker,
    Trade,
    now_ms,
)

EXCHANGE = "binance"


class BinanceAdapter:
    exchange = EXCHANGE

    def __init__(self, public_base: str, private_base: str):
        self.public_base = public_base.rstrip("/")
        self.private_base = private_base.rstrip("/")
        self._official_public = urllib.parse.urlsplit(self.public_base).hostname in {
            "data-api.binance.vision", "api.binance.com"
        }
        self._official_private = urllib.parse.urlsplit(self.private_base).hostname == "api.binance.com"
        self._public_live_verified = False
        self._private_live_verified = False

    def _record_public_success(self) -> None:
        if self._official_public:
            self._public_live_verified = True

    def _record_private_success(self) -> None:
        if self._official_private:
            self._private_live_verified = True

    # ----- capabilities ---------------------------------------------------
    @property
    def capabilities(self) -> dict[str, Capability]:
        public_status = (CapabilityStatus.VERIFIED_LIVE if self._public_live_verified
                         else CapabilityStatus.NEEDS_VERIFICATION)
        public_detail = (
            "a successful public read from an official Binance host was observed by this process"
            if self._public_live_verified else
            "implemented from the official docs; this environment has not yet observed a successful "
            "read from an official Binance host"
        )
        private_status = (CapabilityStatus.VERIFIED_LIVE if self._private_live_verified
                          else CapabilityStatus.NEEDS_VERIFICATION)
        return {
            "public_market_data": Capability(public_status, public_detail),
            "websocket_market_data": Capability(CapabilityStatus.VERIFIED_DOCS,
                                                "wss stream names per docs; proxied stream lands in M2"),
            "account_balances": Capability(private_status,
                                           "signed /api/v3/account implemented per official docs; "
                                           + ("a successful signed read was observed by this process"
                                              if self._private_live_verified else
                                              "no real signed account read has been observed here")),
            "place_order": Capability(CapabilityStatus.NOT_IMPLEMENTED,
                                      "planned M2/M3 after risk-engine hardening"),
            "cancel_order": Capability(CapabilityStatus.NOT_IMPLEMENTED, "planned M2/M3"),
            "order_history": Capability(CapabilityStatus.NOT_IMPLEMENTED, "planned M2"),
            "derivatives": Capability(CapabilityStatus.NOT_IMPLEMENTED,
                                      "only spot; futures requires separate verified implementation"),
        }

    # ----- public market data ----------------------------------------------
    async def ping(self) -> bool:
        await http.get_json(f"{self.public_base}/api/v3/ping")
        self._record_public_success()
        return True

    async def tickers(self, symbol: str | None = None) -> Envelope:
        path = "/api/v3/ticker/24hr" + (f"?symbol={symbol}" if symbol else "")
        raw = await http.get_json(f"{self.public_base}/api/v3/ticker/24hr", {"symbol": symbol})
        items = raw if isinstance(raw, list) else [raw]
        data = [Ticker(
            symbol=t["symbol"],
            last=float(t["lastPrice"]),
            bid=float(t["bidPrice"]) if t.get("bidPrice") not in (None, "") else None,
            ask=float(t["askPrice"]) if t.get("askPrice") not in (None, "") else None,
            high=float(t["highPrice"]),
            low=float(t["lowPrice"]),
            open=float(t["openPrice"]),
            change_pct=float(t["priceChangePercent"]),
            base_volume=float(t["volume"]),
            quote_volume=float(t.get("quoteVolume") or 0),
            ts_ms=int(t.get("closeTime") or now_ms()),
        ) for t in items]
        self._record_public_success()
        up = max((int(t.ts_ms) for t in data), default=None)
        return self._env(f"GET {path}", data, upstream_ts_ms=up)

    async def klines(self, symbol: str, interval: str, start_ms: int | None = None,
                     end_ms: int | None = None, limit: int = 300) -> Envelope:
        cap = INTERVAL_MS.get(interval)
        if cap is None or cap < 60_000:
            raise ValueError(f"unsupported interval {interval!r}")
        if not (1 <= limit <= 1000):
            raise ValueError("limit must be within 1..1000")
        raw = await http.get_json(f"{self.public_base}/api/v3/klines", {
            "symbol": symbol, "interval": interval,
            "startTime": start_ms, "endTime": end_ms, "limit": limit,
        })
        data = [Kline(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]),
                      float(k[5]), int(k[6])) for k in raw]
        self._record_public_success()
        up_ts = data[-1].close_time_ms if data else None
        return self._env(f"GET /api/v3/klines?symbol={symbol}&interval={interval}", data, up_ts)

    async def orderbook(self, symbol: str, limit: int = 50) -> Envelope:
        if limit not in (5, 10, 20, 50, 100, 500, 1000, 5000):
            raise ValueError("depth limit must be one of 5,10,20,50,100,500,1000,5000")
        raw = await http.get_json(f"{self.public_base}/api/v3/depth", {"symbol": symbol, "limit": limit})
        ob = OrderBook(
            bids=[Level(float(p), float(q)) for p, q in raw["bids"]],
            asks=[Level(float(p), float(q)) for p, q in raw["asks"]],
            ts_ms=now_ms(),
        )
        self._record_public_success()
        return self._env(f"GET /api/v3/depth?symbol={symbol}&limit={limit}", ob)

    async def trades(self, symbol: str, limit: int = 50) -> Envelope:
        if not (1 <= limit <= 1000):
            raise ValueError("limit must be within 1..1000")
        raw = await http.get_json(f"{self.public_base}/api/v3/trades", {"symbol": symbol, "limit": limit})
        data = [Trade(str(t["id"]), float(t["price"]), float(t["qty"]), int(t["time"]),
                      bool(t["isBuyerMaker"])) for t in raw]
        self._record_public_success()
        return self._env(f"GET /api/v3/trades?symbol={symbol}&limit={limit}",
                         data, upstream_ts_ms=max((t.ts_ms for t in data), default=None))

    # ----- private (signed, docs-verified) ---------------------------------
    @staticmethod
    def _sign(query: str, secret: str) -> str:
        return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()

    async def account(self, cred: ExchangeCredential) -> Envelope:
        """GET /api/v3/account (HMAC-SHA256 signed). VERIFIED_DOCS; live status reported honestly."""
        from ..security import decrypt_secret
        api_key = decrypt_secret(cred.encrypted_key)
        api_secret = decrypt_secret(cred.encrypted_secret)
        params = {"timestamp": now_ms(), "recvWindow": 5000}
        query = urllib.parse.urlencode(params, doseq=True)
        sig = self._sign(query, api_secret)
        url = f"{self.private_base}/api/v3/account?{query}&signature={sig}"
        raw = await http.get_json(url, extra_headers={"X-MBX-APIKEY": api_key})
        data: dict[str, Any] = {
            "can_trade": raw.get("canTrade"),
            "account_type": raw.get("accountType"),
            "balances": [
                {"asset": b["asset"], "free": float(b["free"]), "locked": float(b["locked"])}
                for b in raw.get("balances", []) if float(b["free"]) > 0 or float(b["locked"]) > 0
            ],
        }
        self._record_private_success()
        return self._env("GET {private}/api/v3/account (signed)", data,
                         verified=(CapabilityStatus.VERIFIED_LIVE if self._private_live_verified
                                   else CapabilityStatus.VERIFIED_DOCS))

    def _env(self, endpoint: str, data: Any, upstream_ts_ms: int | None = None,
             verified: CapabilityStatus | None = None,
             stale_after_ms: int = 15_000) -> Envelope:
        if verified is None:
            verified = (CapabilityStatus.VERIFIED_LIVE if self._public_live_verified
                        else CapabilityStatus.VERIFIED_DOCS)
        return Envelope(exchange=self.exchange, endpoint=endpoint,
                        source_url=self.public_base, ts_ms=now_ms(),
                        stale_after_ms=stale_after_ms, data=data,
                        upstream_ts_ms=upstream_ts_ms, verified=verified)
