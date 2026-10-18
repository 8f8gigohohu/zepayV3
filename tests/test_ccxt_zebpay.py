import hashlib
import hmac
from urllib.parse import urlsplit

import ccxt


def test_pinned_ccxt_release_exposes_zebpay_spot_private_reads():
    exchange = ccxt.zebpay({
        "apiKey": "public-test-key",
        "secret": "private-test-secret",
        "options": {"defaultType": "spot", "fetchMarkets": {"types": ["spot"]}},
    })
    exchange.milliseconds = lambda: 1_700_000_000_123
    signed = exchange.sign(
        "v2/account/balance",
        ["private", "spot"],
        "GET",
        {"currency": "INR"},
    )
    assert signed["url"].startswith("https://sapi.zebpay.com/api/v2/account/balance?")
    assert signed["headers"]["X-AUTH-APIKEY"] == "public-test-key"
    assert "X-AUTH-SIGNATURE" in signed["headers"]
    assert "timestamp=1700000000123" in urlsplit(signed["url"]).query
    assert exchange.has["fetchBalance"] is True


def test_pinned_ccxt_read_signing_matches_zebpay_hmac_sha256_rules():
    secret = "synthetic-test-secret"
    exchange = ccxt.zebpay({
        "apiKey": "synthetic-test-key",
        "secret": secret,
        "options": {"defaultType": "spot", "fetchMarkets": {"types": ["spot"]}},
    })
    exchange.milliseconds = lambda: 1_700_000_000_123

    signed_get = exchange.sign(
        "v2/account/balance",
        ["private", "spot"],
        "GET",
        {"currency": "INR"},
    )
    get_payload = urlsplit(signed_get["url"]).query
    expected_get_signature = hmac.new(secret.encode(), get_payload.encode(), hashlib.sha256).hexdigest()
    assert signed_get["headers"]["X-AUTH-APIKEY"] == "synthetic-test-key"
    assert signed_get["headers"]["X-AUTH-SIGNATURE"] == expected_get_signature
    assert "timestamp=1700000000123" in get_payload
