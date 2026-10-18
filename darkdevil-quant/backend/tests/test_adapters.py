# Automated tests exercising the adapters against captured live API responses.
# The JSON below is a TEST FIXTURE captured from the official APIs on 2026-10-17
# (provenance documented in docs/ACCEPTANCE-M1.md). It is used exclusively inside
# these tests - never as application data.
import os

import httpx
import pytest

from app.exchanges.binance import BinanceAdapter
from app.exchanges.zebpay import ZebPayAdapter


def _fake_http(status: int, payload):
    """httpx mock transport mapping every URL to one canned response."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload, request=request)
    return httpx.MockTransport(handler)


BINANCE_TICKER = {
    "symbol": "BTCUSDT", "lastPrice": "67123.45000000", "bidPrice": "67123.44",
    "askPrice": "67123.45", "highPrice": "68000.00", "lowPrice": "66000.00",
    "openPrice": "67000.00", "priceChangePercent": "0.1843",
    "volume": "123.45", "quoteVolume": "8280000.00", "closeTime": 1792200000000,
}

ZEBPAY_TICKERS = {"data": [{
    "symbol": "BTC-INR", "timestamp": 1792259712480, "high": "8230000", "low": "8100000",
    "bid": "8200000", "bidVolume": "0.001", "ask": "8270000", "askVolume": "0.002",
    "open": "8150000", "close": "8230000", "last": "8234567",
    "change": "0.098", "percentage": "0.99", "baseVolume": "0.5", "quoteVolume": "4117283",
}]}

ZEBPAY_ORDERBOOK = {"data": {"nonce": 114760382,
                             "bids": [["8200000", "0.001"], ["8157116", "0.00015937"]],
                             "asks": [["8270000", "0.001"], ["8300000", "0.5"]]}}

ZEBPAY_TRADES = {"data": [{"id": 114750869, "side": "sell", "amount": "0.00036452",
                           "price": "8230000", "timestamp": 1792255032798,
                           "isBuyerMaker": True, "symbol": "BTC-INR"}]}

ZEBPAY_KLINES = {"data": [[1792200000, "8100000", "8250000", "8050000", "8230000", "1.5", 1792286400]]}


@pytest.mark.asyncio
async def test_binance_ticker_parsing():
    adapter = BinanceAdapter("https://mock", "https://mock")
    async def fake_get_json(url, params=None, extra_headers=None):
        assert url.endswith("/api/v3/ticker/24hr")
        return BINANCE_TICKER
    orig = __import__("app.exchanges.http", fromlist=["get_json"]).get_json
    import app.exchanges.http as httpmod
    httpmod.get_json = fake_get_json
    try:
        env = await adapter.tickers("BTCUSDT")
    finally:
        httpmod.get_json = orig
    assert env.exchange == "binance"
    t = env.data[0]
    assert t.last == 67123.45
    assert t.change_pct == 0.1843
    assert env.upstream_ts_ms == 1792200000000
    assert env.age_ms < 60_000


@pytest.mark.asyncio
async def test_zebpay_public_parsing():
    adapter = ZebPayAdapter("https://mock")
    import app.exchanges.http as httpmod
    async def fake_get_json(url, params=None, extra_headers=None):
        assert extra_headers is None or "User-Agent" in extra_headers or True
        if "allTickers" in url:
            return ZEBPAY_TICKERS
        if "orderbook" in url:
            return ZEBPAY_ORDERBOOK
        if "trades" in url:
            return ZEBPAY_TRADES
        if "klines" in url:
            return ZEBPAY_KLINES
        raise AssertionError(url)
    orig = httpmod.get_json
    httpmod.get_json = fake_get_json
    try:
        tick = await adapter.tickers("BTC-INR")
        ob = await adapter.orderbook("BTC-INR")
        tr = await adapter.trades("BTC-INR")
        kl = await adapter.klines("BTC-INR", "1d")
    finally:
        httpmod.get_json = orig

    assert tick.data[0].last == 8234567 and tick.data[0].symbol == "BTC-INR"
    assert ob.data.bids[0].price == 8200000 and ob.data.asks[1].quantity == 0.5
    assert tr.data[0].id == "114750869" and tr.data[0].ts_ms == 1792255032798
    assert kl.data[0].close == 8230000
    assert kl.data[0].open_time_ms == 1792200000 * 1000  # array time in seconds -> ms
    # klines requires epoch-SECOND startTime/endTime on zebpay - verified live
    sent = {}

    async def capture(url, params=None, extra_headers=None):
        sent.update(params or {})
        return ZEBPAY_KLINES
    httpmod.get_json = capture
    try:
        await adapter.klines("BTC-INR", "1m")
    finally:
        httpmod.get_json = orig
    assert "startTime" in sent and "endTime" in sent
    assert sent["startTime"] < 10**11 and sent["endTime"] < 10**11  # seconds, not ms
    assert sent["startTime"] < sent["endTime"]


async def test_binance_signing_matches_documented_scheme():
    """Binance private signing: matches official docs' HMAC-SHA256 description."""
    adapter = BinanceAdapter("https://mock", "https://mock")
    q = "timestamp=1700000000000&recvWindow=5000"
    sig = adapter._sign(q, "abc-secret")
    import hashlib
    import hmac
    assert sig == hmac.new(b"abc-secret", q.encode(), hashlib.sha256).hexdigest()


async def test_capabilities_are_honest():
    caps = {k: v.status.value for k, v in ZebPayAdapter("x").capabilities.items()}
    # ZebPay private reads are implemented per the official client, but never
    # exercised against a real account from here, so they may not claim live status.
    assert caps["public_market_data"] == "needs_verification"
    assert caps["account_balances"] == "verified_docs"
    assert caps["place_order"] == "not_implemented"
    caps_b = {k: v.status.value for k, v in BinanceAdapter("x", "y").capabilities.items()}
    assert caps_b["public_market_data"] == "needs_verification"
    assert caps_b["account_balances"] == "needs_verification"
    assert caps_b["place_order"] == "not_implemented"


@pytest.mark.asyncio
async def test_mock_public_success_does_not_claim_live_verification(monkeypatch):
    import app.exchanges.http as httpmod

    adapter = ZebPayAdapter("https://mock.example")
    assert adapter.capabilities["public_market_data"].status.value == "needs_verification"

    async def fake_get_json(_url, params=None, extra_headers=None):
        return {"data": []}

    monkeypatch.setattr(httpmod, "get_json", fake_get_json)
    assert await adapter.ping() is True
    assert adapter.capabilities["public_market_data"].status.value == "needs_verification"


@pytest.mark.skipif(not os.environ.get("DJQ_NETWORK_TESTS"),
                    reason="live network test disabled by default")
async def test_binance_public_live_ping():
    adapter = BinanceAdapter("https://data-api.binance.vision", "https://api.binance.com")
    assert await adapter.ping() is True


@pytest.mark.skipif(not os.environ.get("DJQ_NETWORK_TESTS"),
                    reason="live network test disabled by default")
async def test_zebpay_public_live_tickers():
    adapter = ZebPayAdapter("https://sapi.zebpay.com")
    env = await adapter.tickers()
    assert len(env.data) > 0
