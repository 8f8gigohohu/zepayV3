import asyncio
from decimal import Decimal

import httpx

from zepay_trader.kronos import KronosAdapter
from zepay_trader.main import create_app
from zepay_trader.runtime_config import RuntimeConfigManager
from zepay_trader.storage import Store
from tests.test_trading import FakeGateway


def run_api_test(app, callback):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            return await callback(client)
    return asyncio.run(run())


def test_paper_dashboard_and_order_routes(settings_factory, tmp_path):
    settings = settings_factory(paper_starting_inr=Decimal("1000"))
    store = Store(settings.database_path, settings.paper_starting_inr)
    runtime = RuntimeConfigManager(tmp_path / "runtime.yaml")
    app = create_app(
        settings=settings,
        gateway=FakeGateway(),
        store=store,
        kronos=KronosAdapter(settings),
        runtime_config=runtime,
    )

    async def exercise(client):
        health = (await client.get("/api/health")).json()
        assert health["mode"] == "paper"
        assert health["live_ready"] is False
        assert "never replaced with sample prices" in health["market_data"]

        quote = (await client.get("/api/market", params={"symbol": "BTC/INR"})).json()
        assert quote["source"] == "test"
        assert quote["is_simulated"] is False

        response = await client.post("/api/orders", json={
            "symbol": "BTC/INR", "side": "buy", "order_type": "limit", "amount": "1", "price": "101"
        })
        assert response.status_code == 200
        assert response.json()["status"] == "filled"
        assert response.json()["mode"] == "paper"

        portfolio = (await client.get("/api/portfolio")).json()
        assert portfolio["balances"]
        assert portfolio["open_orders"] == 0
        assert portfolio["day_trades"] == 1
        assert (await client.get("/api/orders", params={"symbol": "BTC/INR"})).json()["orders"][0]["status"] == "filled"
        assert len((await client.get("/api/positions")).json()["positions"]) == 1
        assert len((await client.get("/api/journal/trades")).json()["trades"]) == 1
        assert (await client.get("/api/risk")).status_code == 200
        assert (await client.get("/api/config")).json()["runtime"]["trading"]["symbol"] == "BTC/INR"

    run_api_test(app, exercise)


def test_live_account_routes_require_operator_login(settings_factory, tmp_path):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="api-key",
        api_secret="secret",
        app_password="a-strong-test-password",
        secure_cookie=True,
    )
    store = Store(settings.database_path, settings.paper_starting_inr)
    app = create_app(
        settings=settings,
        gateway=FakeGateway(),
        store=store,
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )

    async def exercise(client):
        response = await client.get("/api/portfolio")
        assert response.status_code == 401
        response = await client.post("/api/orders", json={
            "symbol": "BTC/INR", "side": "buy", "amount": "0.001", "price": "100000"
        })
        assert response.status_code == 401

        login = await client.post("/api/auth/login", json={"password": "a-strong-test-password"})
        assert login.status_code == 200
        portfolio = await client.get("/api/portfolio")
        assert portfolio.status_code == 200
        assert portfolio.json()["equity_complete"] is True
        live_order = await client.post("/api/orders", json={
            "symbol": "BTC/INR", "side": "buy", "amount": "0.001", "price": "100000"
        })
        assert live_order.status_code == 423
        assert live_order.json()["code"] == "live_trading_locked"
        assert (await client.post("/api/auth/logout")).status_code == 200
        assert (await client.get("/api/portfolio")).status_code == 401

    run_api_test(app, exercise)


def test_first_run_setup_stores_secrets_and_live_arm_requires_connection_check(settings_factory, tmp_path):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=False,
        app_password="",
        jwt_secret="",
        secure_cookie=False,
        api_key="",
        api_secret="",
        database_path=tmp_path / "data" / "test.sqlite3",
    )
    gateway = FakeGateway()
    app = create_app(
        settings=settings,
        gateway=gateway,
        store=Store(settings.database_path, settings.paper_starting_inr),
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )
    token_path = settings.database_path.parent / "initial-setup.token"
    private_path = settings.database_path.parent / "private_settings.json"
    assert token_path.is_file()
    assert token_path.stat().st_mode & 0o777 == 0o600

    async def exercise(client):
        setup_token = token_path.read_text(encoding="utf-8").strip()
        headers = {"Origin": "https://test"}
        bootstrap = await client.post("/api/auth/bootstrap", headers=headers, json={
            "setup_token": setup_token,
            "api_key": "test-exchange-api-key",
            "api_secret": "test-exchange-api-secret",
            "app_password": "strong-operator-password",
            "password_confirmation": "strong-operator-password",
        })
        assert bootstrap.status_code == 200, bootstrap.text
        assert bootstrap.json()["authenticated"] is True
        assert bootstrap.json()["live_order_routing_supported"] is False
        assert "test-exchange-api-key" not in bootstrap.text
        assert "test-exchange-api-secret" not in bootstrap.text
        assert not token_path.exists()
        assert private_path.stat().st_mode & 0o777 == 0o600

        health = (await client.get("/api/health")).json()
        assert health["operator_auth_ready"] is True
        assert health["live_ready"] is False
        assert health["operator_authenticated"] is True

        tested = await client.post("/api/settings/test-connection", headers=headers, json={"symbol": "BTC/INR"})
        assert tested.status_code == 200
        assert tested.json()["ok"] is True
        assert tested.json()["orders_submitted"] == 0

        armed = await client.post("/api/settings/live-arm", headers=headers, json={"armed": True})
        assert armed.status_code == 423
        assert armed.json()["code"] == "live_trading_locked"
        assert "conflict" in armed.json()["error"].lower()

        disarmed = await client.post("/api/settings/live-arm", headers=headers, json={"armed": False})
        assert disarmed.status_code == 200
        assert disarmed.json()["live_ready"] is False

        public_config = (await client.get("/api/config")).text
        assert "test-exchange-api-key" not in public_config
        assert "test-exchange-api-secret" not in public_config

    run_api_test(app, exercise)


def test_live_arm_remains_disabled_even_when_zebpay_reads_pass(settings_factory, tmp_path):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=False,
        api_key="test-api-key",
        api_secret="test-api-secret",
        app_password="strong-operator-password",
        secure_cookie=True,
    )
    gateway = FakeGateway()
    connection_checks = []
    gateway.test_connection = lambda _symbol="BTC/INR": connection_checks.append(_symbol) or {
        "ok": True,
        "market_data": {"ok": True, "source": "test"},
        "private_account": {"ok": True, "assets_returned": 2},
        "orders_submitted": 0,
    }
    app = create_app(
        settings=settings,
        gateway=gateway,
        store=Store(settings.database_path, settings.paper_starting_inr),
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )

    async def exercise(client):
        login = await client.post("/api/auth/login", json={"password": "strong-operator-password"})
        assert login.status_code == 200
        response = await client.post("/api/settings/live-arm", headers={"Origin": "https://test"}, json={"armed": True})
        assert response.status_code == 423
        assert "conflict" in response.json()["error"].lower()
        assert connection_checks == []
        health = (await client.get("/api/health")).json()
        assert health["live_ready"] is False
        assert health["operator_authenticated"] is True

    run_api_test(app, exercise)


def test_live_strategy_start_is_rejected_even_with_all_gates_configured(settings_factory, tmp_path):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        auto_live_trading_enabled=True,
        api_key="test-api-key",
        api_secret="test-api-secret",
        app_password="strong-operator-password",
        jwt_secret="test-jwt-secret-that-is-long-enough-to-pass",
        secure_cookie=True,
    )
    app = create_app(
        settings=settings,
        gateway=FakeGateway(),
        store=Store(settings.database_path, settings.paper_starting_inr),
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )

    async def exercise(client):
        login = await client.post("/api/auth/login", json={"password": "strong-operator-password"})
        assert login.status_code == 200
        response = await client.post("/api/strategy/start", json={})
        assert response.status_code == 423
        assert response.json()["code"] == "live_trading_locked"
        assert "conflict" in response.json()["error"].lower()

    run_api_test(app, exercise)


def test_credential_rotation_keeps_live_writes_disabled_and_does_not_echo_keys(settings_factory, tmp_path):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="old-api-key",
        api_secret="old-api-secret",
        app_password="strong-operator-password",
        secure_cookie=True,
    )
    app = create_app(
        settings=settings,
        gateway=FakeGateway(),
        store=Store(settings.database_path, settings.paper_starting_inr),
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )

    async def exercise(client):
        assert (await client.post("/api/auth/login", json={"password": "strong-operator-password"})).status_code == 200
        response = await client.post("/api/settings/credentials", headers={"Origin": "https://test"}, json={
            "api_key": "replacement-api-key",
            "api_secret": "replacement-api-secret",
        })
        assert response.status_code == 200
        assert "replacement-api-key" not in response.text
        assert "replacement-api-secret" not in response.text
        health = (await client.get("/api/health")).json()
        assert health["credentials_configured"] is True
        assert health["live_ready"] is False

    run_api_test(app, exercise)


def test_bootstrap_validation_never_echoes_a_submitted_password(settings_factory, tmp_path):
    settings = settings_factory(database_path=tmp_path / "test.sqlite3")
    app = create_app(
        settings=settings,
        gateway=FakeGateway(),
        store=Store(settings.database_path, settings.paper_starting_inr),
        kronos=KronosAdapter(settings),
        runtime_config=RuntimeConfigManager(tmp_path / "runtime.yaml"),
    )
    token_path = settings.database_path.parent / "initial-setup.token"

    async def exercise(client):
        response = await client.post("/api/auth/bootstrap", headers={"Origin": "https://test"}, json={
            "setup_token": token_path.read_text(encoding="utf-8").strip(),
            "api_key": "validation-api-key",
            "api_secret": "validation-api-secret",
            "app_password": "too-short",
            "password_confirmation": "too-short",
        })
        assert response.status_code == 422
        assert "too-short" not in response.text
        assert "validation-api-secret" not in response.text

    run_api_test(app, exercise)
