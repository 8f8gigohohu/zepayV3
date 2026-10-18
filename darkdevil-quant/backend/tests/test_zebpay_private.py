# Automated tests - all credentials here are synthetic fixtures created inside the
# temporary test database. No live exchange is contacted: the upstream base URL is
# rewritten to a non-resolving host by conftest.py.
#
# The signing vectors below were produced by running the ALGORITHM FROM THE OFFICIAL
# ZEBPAY SPOT CLIENT (spot/clients/rest-http/node/utils/auth.js: encodeURIComponent
# joined with '&', HMAC-SHA256 hex, timestamp last) in Node with a fixed clock, then
# pasted here. They are a cross-implementation check, not a self-comparison.
import json

import pytest

from app.exchanges import http
from app.exchanges.zebpay import (
    ZebPayAdapter,
    build_query,
    describe_upstream,
    encode_component,
    sign_query,
)
from app.models import ExchangeCredential
from app.security import encrypt_secret

# --- vectors produced by the official client's algorithm ---------------------
VECTOR_PARAMS = {"symbol": "BTC-INR", "currencies": "BTC,ETH,INR"}
VECTOR_TS = 1_760_700_000_123
VECTOR_QUERY = "symbol=BTC-INR&currencies=BTC%2CETH%2CINR&timestamp=1760700000123"
VECTOR_SIG = "080942f81ce0d0802b8d9ed891ee12479edee36185bb8f75b9eeca307314f77d"
VECTOR_SECRET = "unit-test-secret"


def _cred() -> ExchangeCredential:
    return ExchangeCredential(
        user_id=1, exchange="zebpay",
        key_masked="test...1234",
        encrypted_key=encrypt_secret("test-fixture-key-1234567890"),
        encrypted_secret=encrypt_secret(VECTOR_SECRET),
    )


class _Capture:
    """Async stand-in for http.get_json that records the exact wire request."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, url, params=None, extra_headers=None):
        self.calls.append((url, extra_headers or {}))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_signature_matches_official_client_vector():
    query, headers = sign_query("key", VECTOR_SECRET, VECTOR_PARAMS, VECTOR_TS)
    assert query == VECTOR_QUERY
    assert headers["x-auth-signature"] == VECTOR_SIG
    # The secret itself must never travel in the request.
    assert "secret" not in json.dumps(headers).lower()
    assert VECTOR_SECRET not in query


def test_query_is_built_with_timestamp_last():
    assert build_query({"symbol": "ETH-INR"}, 1) == "symbol=ETH-INR&timestamp=1"


def test_encoding_matches_encodeuri_component():
    # Value and expected output taken from Node's encodeURIComponent().
    raw = "a b!*'(),-/_.~:é"
    assert encode_component(raw) == "a%20b!*'()%2C-%2F_.~%3A%C3%A9"
    # The four characters where Python's quote() and JS disagree.
    assert encode_component("!*'()") == "!*'()"


def test_balance_read_sends_a_verifiable_request(monkeypatch):
    capture = _Capture([{"data": [
        {"currency": "BTC", "free": "0.10000000", "used": "0.02345678",
         "total": "0.12345678", "isFiat": False},
        {"currency": "INR", "free": "100", "used": "0", "total": "100", "isFiat": True},
        {"currency": "ETH", "free": "0", "used": "0", "total": "0", "isFiat": False},
    ], "statusCode": 200}])
    monkeypatch.setattr(http, "get_json", capture)

    env = asyncio_run(ZebPayAdapter("https://api.example").account(_cred()))
    url, headers = capture.calls[0]

    query = url.split("?", 1)[1]
    # Signature must cover exactly the bytes sent, including the timestamp param.
    assert query.startswith("timestamp=")
    expected = sign_query(headers["x-auth-apikey"], VECTOR_SECRET,
                          {}, int(query.split("timestamp=")[1]))[1]["x-auth-signature"]
    assert headers["x-auth-signature"] == expected
    assert headers["x-auth-apikey"] == "test-fixture-key-1234567890"

    data = env.data
    assert data["timestamp_unit"] == "ms"
    # Zero balances are dropped; string amounts become numbers; fiat is labelled.
    assert [b["asset"] for b in data["balances"]] == ["BTC", "INR"]
    assert data["balances"][0]["locked"] == pytest.approx(0.02345678)
    assert data["balances"][1]["is_fiat"] is True
    assert env.verified.value == "verified_docs"


def test_orders_read_requires_symbol_and_parses_items(monkeypatch):
    capture = _Capture([{"data": {"items": [{
        "orderId": 6016691, "symbol": "BTC-INR", "side": "BUY", "type": "LIMIT",
        "price": "5333400", "amount": "0.0001", "filled": "0", "remaining": "0.0001",
        "status": "OPEN", "timeInForce": "GTC", "timestamp": 1744362483471,
    }], "totalNum": 1}, "statusCode": 200}])
    monkeypatch.setattr(http, "get_json", capture)

    env = asyncio_run(ZebPayAdapter("https://api.example").open_orders(_cred(), "BTC-INR"))
    url, _ = capture.calls[0]
    assert "symbol=BTC-INR" in url and "status=ACTIVE" in url
    assert env.data["orders"][0]["order_id"] == 6016691
    assert env.data["count"] == 1


def test_expired_timestamp_retries_once_in_seconds(monkeypatch):
    expired = http.UpstreamError(401, json.dumps(
        {"data": None, "statusCode": 2003, "statusDescription": "expired timestamp"}))
    capture = _Capture([expired, {"data": [], "statusCode": 200}])
    monkeypatch.setattr(http, "get_json", capture)

    env = asyncio_run(ZebPayAdapter("https://api.example").account(_cred()))
    assert len(capture.calls) == 2
    first_ts = int(capture.calls[0][0].split("timestamp=")[1])
    second_ts = int(capture.calls[1][0].split("timestamp=")[1])
    assert first_ts > 10**12 and second_ts < 10**11  # millis, then seconds
    assert env.data["timestamp_unit"] == "s"
    assert env.data["balances"] == []


def test_invalid_signature_is_not_retried(monkeypatch):
    """Only the documented timestamp ambiguity is reconciled; a genuine auth
    failure must surface immediately, with ZebPay's own wording."""
    bad_sig = http.UpstreamError(401, json.dumps(
        {"data": None, "statusCode": 2002, "statusDescription": "invalid signature"}))
    capture = _Capture([bad_sig])
    monkeypatch.setattr(http, "get_json", capture)

    with pytest.raises(http.UpstreamError) as exc:
        asyncio_run(ZebPayAdapter("https://api.example").account(_cred()))
    assert len(capture.calls) == 1
    assert "2002" in str(exc.value) and "invalid signature" in str(exc.value)


def test_describe_upstream_translates_documented_codes():
    desc, expired = describe_upstream(http.UpstreamError(
        401, json.dumps({"data": None, "statusCode": 2001,
                         "statusDescription": "invalid api key"})))
    assert expired is False
    assert "2001" in desc and "invalid api key" in desc

    desc, expired = describe_upstream(http.UpstreamError(
        401, json.dumps({"statusCode": 2003, "statusDescription": "expired timestamp"})))
    assert expired is True and "expired timestamp" in desc

    # Non-JSON upstream bodies must still produce something readable.
    desc, expired = describe_upstream(http.UpstreamError(451, "<html>blocked</html>"))
    assert expired is False and "451" in desc


def test_order_placement_and_cancel_refuse_by_construction():
    adapter = ZebPayAdapter("https://api.example")
    with pytest.raises(NotImplementedError) as place:
        adapter.place_order(symbol="BTC-INR", side="BUY", type="LIMIT")
    assert "amount vs quantity" in str(place.value)

    with pytest.raises(NotImplementedError) as cancel:
        adapter.cancel_order(1)
    assert "/ex/order?orderId=" in str(cancel.value)


def test_capabilities_never_claim_orders_are_ready():
    caps = ZebPayAdapter("https://api.example").capabilities
    assert caps["account_balances"].status.value == "verified_docs"
    assert caps["order_history"].status.value == "verified_docs"
    for key in ("place_order", "cancel_order"):
        assert caps[key].status.value == "not_implemented"


# --- tiny helper so these tests stay readable without pytest-asyncio decorators
def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)
