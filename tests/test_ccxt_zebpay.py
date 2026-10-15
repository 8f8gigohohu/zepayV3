import json

import ccxt


def test_pinned_ccxt_release_exposes_zebpay_spot_and_signs_live_order():
    exchange = ccxt.zebpay({
        "apiKey": "public-test-key",
        "secret": "private-test-secret",
        "options": {"defaultType": "spot", "fetchMarkets": {"types": ["spot"]}},
    })
    exchange.milliseconds = lambda: 1_700_000_000_123
    signed = exchange.sign(
        "v2/ex/orders",
        ["private", "spot"],
        "POST",
        {"symbol": "BTC-INR", "side": "BUY", "type": "LIMIT", "amount": "0.001", "price": "100"},
    )
    assert signed["url"] == "https://sapi.zebpay.com/api/v2/ex/orders"
    assert signed["headers"]["X-AUTH-APIKEY"] == "public-test-key"
    assert "X-AUTH-SIGNATURE" in signed["headers"]
    assert json.loads(signed["body"])["timestamp"] == "1700000000123"
    assert exchange.has["createOrder"] is True
    assert exchange.has["fetchBalance"] is True
