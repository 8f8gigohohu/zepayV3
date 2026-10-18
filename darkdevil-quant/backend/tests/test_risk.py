# Automated tests for the fail-closed risk engine and order endpoint gating.
import pytest

from app.config import Settings
from app.risk.engine import OrderRequest, RiskEngine
from tests.helpers import csrf_headers


def cfg(**kw) -> Settings:
    base = dict(live_trading_enabled=False, kill_switch_default_active=True,
                environment="development", secret_key="k" * 40)
    base.update(kw)
    return Settings(**base)


def req(**kw) -> OrderRequest:
    base = dict(exchange="binance", symbol="BTCUSDT", side="buy", type="limit",
                quantity_quote=100.0, idempotency_key="idem-1234abcd", live_trading=True)
    base.update(kw)
    return OrderRequest(**base)


def test_live_trading_disabled_blocks_by_default():
    d = RiskEngine(cfg()).check(req(), kill_switch_active=True,
                                adapter_caps={"place_order": "not_implemented"})
    assert not d.allowed
    joined = d.reason
    assert "live trading is globally DISABLED" in joined
    assert "kill switch is ACTIVE" in joined
    assert "place_order" in joined


def test_releasing_gates_still_blocks_on_unverified_adapter():
    d = RiskEngine(cfg(live_trading_enabled=True)).check(
        req(), kill_switch_active=False, adapter_caps={"place_order": "needs_verification"})
    assert not d.allowed
    assert "place_order" in d.reason


def test_only_fully_verified_adapter_and_released_gates_pass_checks():
    d = RiskEngine(cfg(live_trading_enabled=True)).check(
        req(), kill_switch_active=False, adapter_caps={"place_order": "verified_live"})
    assert d.allowed, d.reasons


def test_notional_limit_enforced():
    d = RiskEngine(cfg(live_trading_enabled=True, max_order_notional_quote=500)).check(
        req(quantity_quote=600), kill_switch_active=False,
        adapter_caps={"place_order": "verified_live"})
    assert not d.allowed
    assert any("exceeds max_order_notional_quote" in r for r in d.reasons)


def test_stale_market_data_blocks():
    now = 10_000_000
    d = RiskEngine(cfg(live_trading_enabled=True)).check(
        req(), kill_switch_active=False, adapter_caps={"place_order": "verified_live"},
        market_ts_ms=now - 31_000, now_ms_=now)
    assert not d.allowed
    assert any("stale" in r for r in d.reasons)
    d2 = RiskEngine(cfg(live_trading_enabled=True)).check(
        req(), kill_switch_active=False, adapter_caps={"place_order": "verified_live"},
        market_ts_ms=now - 10_000, now_ms_=now)
    assert d2.allowed


def test_invalid_inputs_rejected():
    d = RiskEngine(cfg(live_trading_enabled=True)).check(
        req(side="SHORT", type="iceberg", idempotency_key=""),
        kill_switch_active=False, adapter_caps={"place_order": "verified_live"})
    assert not d.allowed
    assert len(d.reasons) >= 3


@pytest.mark.asyncio
async def test_order_endpoint_rejects_and_audits(client):
    # register admin
    r = await client.post("/api/auth/register", json={
        "email": "trader@example.com", "password": "correct-horse-99"})
    headers = csrf_headers(client)
    assert "access_token" not in r.json()
    r2 = await client.post("/api/trading/orders", headers=headers, json={
        "exchange": "binance", "symbol": "BTCUSDT", "side": "buy", "type": "limit",
        "quantity_quote": 100, "idempotency_key": "test-key-00000001"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["status"] == "rejected"
    assert not body["accepted"]

    # idempotency: same key recognized as duplicate
    r3 = await client.post("/api/trading/orders", headers=headers, json={
        "exchange": "binance", "symbol": "BTCUSDT", "side": "buy", "type": "limit",
        "quantity_quote": 100, "idempotency_key": "test-key-00000001"})
    assert r3.json()["status"] == "duplicate"


@pytest.mark.asyncio
async def test_unauthenticated_order_attempt_is_401(client):
    r = await client.post("/api/trading/orders", json={
        "exchange": "binance", "symbol": "BTCUSDT", "side": "buy", "type": "limit",
        "quantity_quote": 100, "idempotency_key": "anon-key-0000001"})
    assert r.status_code == 401
