# Automated tests - credentials here are synthetic fixtures inside the temporary
# test database. They never touch a live exchange and never contain real secrets.
import pytest

from tests.helpers import csrf_headers

pytestmark = pytest.mark.asyncio

FAKE_KEY = "test-fixture-key-1234567890"
FAKE_SECRET = "test-fixture-secret-0987654321"


async def _register(client, email="conn@example.com"):
    r = await client.post("/api/auth/register",
                          json={"email": email, "password": "correct-horse-99"})
    assert r.status_code == 201, r.text
    assert "access_token" not in r.json()
    return csrf_headers(client)


async def test_connections_start_not_configured(client):
    h = await _register(client)
    r = await client.get("/api/connections/status", headers=h)
    assert r.status_code == 200
    states = {c["exchange"]: c["state"] for c in r.json()["connections"]}
    assert states == {"binance": "NOT_CONFIGURED", "zebpay": "NOT_CONFIGURED"}
    assert r.json()["guidance"], "security guidance should be returned"


async def test_connections_require_auth(client):
    assert (await client.get("/api/connections/status")).status_code == 401


async def test_saved_credential_is_masked_and_never_returned(client):
    h = await _register(client, "mask@example.com")
    r = await client.post("/api/connections", headers=h, json={
        "exchange": "binance", "api_key": FAKE_KEY, "api_secret": FAKE_SECRET,
        "test_now": False})
    assert r.status_code == 200, r.text
    body = r.json()
    # Secret material must never appear in the response body.
    assert FAKE_SECRET not in r.text
    assert FAKE_KEY not in r.text
    assert body["key_masked"].startswith(FAKE_KEY[:4])
    assert body["key_masked"].endswith(FAKE_KEY[-4:])

    status = await client.get("/api/connections/status", headers=h)
    assert FAKE_SECRET not in status.text
    assert FAKE_KEY not in status.text
    row = next(c for c in status.json()["connections"] if c["exchange"] == "binance")
    # Storing a key must not be reported as a working connection.
    assert row["state"] == "CONFIGURED_UNTESTED"
    assert row["connected"] is False
    assert row["trading_state"] == "NOT_READY_FOR_TRADING"


async def test_validation_errors_do_not_echo_submitted_credentials(client):
    h = await _register(client, "validation@example.com")
    oversized_key = "K" * 300
    oversized_secret = "S" * 300
    r = await client.post("/api/connections", headers=h, json={
        "exchange": "zebpay", "api_key": oversized_key, "api_secret": oversized_secret,
        "test_now": False})
    assert r.status_code == 422
    assert oversized_key not in r.text
    assert oversized_secret not in r.text


async def test_failing_private_read_is_error_and_persisted(client):
    """ZebPay's private read is now implemented, so an unreachable/failing upstream
    must be ERROR with the real reason - never UNSUPPORTED and never success."""
    h = await _register(client, "zeb@example.com")
    await client.post("/api/connections", headers=h, json={
        "exchange": "zebpay", "api_key": FAKE_KEY, "api_secret": FAKE_SECRET,
        "test_now": False})
    r = await client.post("/api/connections/zebpay/test", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["connected"] is False
    assert body["status"] == "fail"
    assert body["state"] == "ERROR"
    assert FAKE_SECRET not in r.text

    # The failure detail must be persisted, not only returned once.
    status = await client.get("/api/connections/status", headers=h)
    row = next(c for c in status.json()["connections"] if c["exchange"] == "zebpay")
    assert row["state"] == "ERROR"
    assert row["last_test_detail"], "failure reason must be stored for the UI"
    assert row["last_test_at"]
    # A failing read must never be reported as trading-ready.
    assert row["trading_state"] == "NOT_READY_FOR_TRADING"


async def test_account_snapshot_requires_credential_and_auth(client):
    assert (await client.get("/api/connections/zebpay/account")).status_code == 401
    h = await _register(client, "snap@example.com")
    assert (await client.get("/api/connections/zebpay/account", headers=h)).status_code == 404
    assert (await client.get("/api/connections/nope/account", headers=h)).status_code == 404

    await client.post("/api/connections", headers=h, json={
        "exchange": "zebpay", "api_key": FAKE_KEY, "api_secret": FAKE_SECRET,
        "test_now": False})
    # Upstream is unreachable in tests: the read must fail loudly, not invent balances.
    r = await client.get("/api/connections/zebpay/account", headers=h)
    assert r.status_code == 502, r.text
    assert "balances" not in r.text
    assert FAKE_SECRET not in r.text


async def test_deleted_credential_returns_to_not_configured(client):
    h = await _register(client, "del@example.com")
    await client.post("/api/connections", headers=h, json={
        "exchange": "binance", "api_key": FAKE_KEY, "api_secret": FAKE_SECRET,
        "test_now": False})
    r = await client.delete("/api/connections/binance", headers=h)
    assert r.status_code == 200
    status = await client.get("/api/connections/status", headers=h)
    row = next(c for c in status.json()["connections"] if c["exchange"] == "binance")
    assert row["state"] == "NOT_CONFIGURED"
    assert row["credential_stored"] is False
    assert row["key_masked"] is None
