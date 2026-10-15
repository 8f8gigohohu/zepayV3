import asyncio
from decimal import Decimal

import httpx

from zepay_trader.kronos import KronosAdapter
from zepay_trader.main import create_app
from zepay_trader.storage import Store
from tests.test_trading import FakeGateway


def run_api_test(app, callback):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            return await callback(client)
    return asyncio.run(run())


def test_paper_dashboard_and_order_routes(settings_factory):
    settings = settings_factory(paper_starting_inr=Decimal("1000"))
    store = Store(settings.database_path, settings.paper_starting_inr)
    app = create_app(settings=settings, gateway=FakeGateway(), store=store, kronos=KronosAdapter(settings))

    async def exercise(client):
        health = (await client.get("/api/health")).json()
        assert health["mode"] == "paper"
        assert health["live_ready"] is False

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
        assert (await client.get("/api/orders", params={"symbol": "BTC/INR"})).json()["orders"][0]["status"] == "filled"

    run_api_test(app, exercise)


def test_live_account_routes_require_operator_login(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="api-key",
        api_secret="secret",
        app_password="a-strong-test-password",
        secure_cookie=True,
    )
    store = Store(settings.database_path, settings.paper_starting_inr)
    app = create_app(settings=settings, gateway=FakeGateway(), store=store, kronos=KronosAdapter(settings))

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
        assert (await client.post("/api/auth/logout")).status_code == 200
        assert (await client.get("/api/portfolio")).status_code == 401

    run_api_test(app, exercise)
