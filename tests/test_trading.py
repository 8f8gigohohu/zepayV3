from decimal import Decimal

import pytest

from zepay_trader.kronos import KronosAdapter
from zepay_trader.risk import RiskViolation
from zepay_trader.schemas import LimitOrderRequest
from zepay_trader.storage import Store
from zepay_trader.trading import LiveTradingDisabled, TradingService


class FakeGateway:
    def __init__(self, quote=None):
        self.quote = quote or {
            "symbol": "BTC/INR", "last": 100.0, "bid": 99.9, "ask": 100.1,
            "high": 101.0, "low": 98.0, "percentage": 1.2,
            "source": "test", "is_simulated": False, "timestamp": 1_700_000_000_000,
        }
        self.submitted = []
        self.cancelled = []

    def ticker(self, symbol):
        return {**self.quote, "symbol": symbol}

    def candles(self, symbol, timeframe, limit):
        step_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[timeframe]
        now_ms = 1_700_000_000_000
        return [
            [now_ms - (limit - index) * step_ms, 100, 101, 99, 100 + index / 100, 2]
            for index in range(limit)
        ]

    def market(self, symbol):
        return {"symbol": symbol, "active": True, "minimum_amount": 0.000001, "minimum_notional": 100}

    def normalize_order(self, symbol, amount, price):
        return amount, price

    def balance(self):
        return {
            "INR": {"free": Decimal("100000"), "total": Decimal("100000")},
            "BTC": {"free": Decimal("10"), "total": Decimal("10")},
            "USDT": {"free": Decimal("0"), "total": Decimal("0")},
        }

    def test_connection(self, symbol="BTC/INR"):
        return {
            "ok": True,
            "tested_at": 1_700_000_000_000,
            "market_data": {"ok": True, "symbol": symbol, "source": "test"},
            "private_account": {"ok": True, "assets_returned": 3},
            "orders_submitted": 0,
        }

    def place_limit_order(self, symbol, side, amount, price, client_order_id):
        self.submitted.append((symbol, side, amount, price, client_order_id))
        return {"id": "ZEB-123", "status": "open", "filled": 0, "info": {"orderId": "ZEB-123"}}

    def cancel_order(self, exchange_order_id, symbol):
        self.cancelled.append((exchange_order_id, symbol))
        return {"id": exchange_order_id, "status": "canceled"}

    def fetch_order(self, exchange_order_id, symbol):
        return {"id": exchange_order_id, "status": "open", "filled": 0}


def make_service(settings, gateway=None):
    store = Store(settings.database_path, settings.paper_starting_inr)
    return TradingService(settings, gateway or FakeGateway(), store, KronosAdapter(settings)), store


def test_paper_limit_order_fills_only_when_crossing_quote(settings_factory):
    settings = settings_factory(paper_starting_inr=Decimal("1000"))
    service, store = make_service(settings)

    resting = service.place_order(LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1.5"), price=Decimal("90")
    ))
    assert resting["status"] == "open"
    assert store.paper_available_balances()["INR"] == Decimal("865")

    crossing = service.place_order(LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101")
    ))
    assert crossing["status"] == "filled"
    balances = store.paper_balances()
    assert balances["BTC"] == Decimal("1")
    assert balances["INR"] == Decimal("899.9")
    assert store.get_order(resting["client_order_id"])["status"] == "open"


def test_risk_caps_and_allowlist_are_enforced(settings_factory):
    settings = settings_factory(
        paper_starting_inr=Decimal("10000"),
        max_order_notional=Decimal("500"),
        max_daily_notional=Decimal("500"),
    )
    service, _store = make_service(settings)

    with pytest.raises(RiskViolation, match="per-order cap"):
        service.place_order(LimitOrderRequest(
            symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("501")
        ))
    with pytest.raises(RiskViolation, match="allowlist"):
        service.place_order(LimitOrderRequest(
            symbol="BTC/USDT", side="buy", amount=Decimal("1"), price=Decimal("100")
        ))


def test_paper_open_orders_reserve_funds(settings_factory):
    settings = settings_factory(
        paper_starting_inr=Decimal("1000"),
        max_order_notional=Decimal("500"),
        max_daily_notional=Decimal("2000"),
    )
    service, store = make_service(settings)
    first = service.place_order(LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("5"), price=Decimal("80")
    ))
    second = service.place_order(LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("6"), price=Decimal("80")
    ))
    assert first["status"] == "open"
    assert second["status"] == "open"
    assert store.paper_available_balances()["INR"] == Decimal("120")
    with pytest.raises(RiskViolation, match="Insufficient free INR"):
        service.place_order(LimitOrderRequest(
            symbol="BTC/INR", side="buy", amount=Decimal("2"), price=Decimal("80")
        ))


def test_live_mode_stays_locked_without_all_server_gates(settings_factory):
    settings = settings_factory(trading_mode="live", live_trading_enabled=True)
    service, _store = make_service(settings)
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("0.001"), price=Decimal("100000")
    )
    with pytest.raises(LiveTradingDisabled):
        service.place_order(request, operator_authenticated=True)


def test_live_readiness_stays_false_even_with_secure_configuration(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=False,
    )
    assert settings.live_ready is False


def test_live_order_is_refused_before_any_exchange_call(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        jwt_secret="test-jwt-secret-that-is-long-enough-to-pass",
        secure_cookie=True,
    )
    gateway = FakeGateway()
    service, _store = make_service(settings, gateway)
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101")
    )
    with pytest.raises(LiveTradingDisabled, match="order routing is fail-closed"):
        service.place_order(request, operator_authenticated=True)
    assert gateway.submitted == []
    assert gateway.cancelled == []


def test_live_cancel_is_refused_and_does_not_call_exchange(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        jwt_secret="test-jwt-secret-that-is-long-enough-to-pass",
        secure_cookie=True,
    )
    gateway = FakeGateway()
    service, store = make_service(settings, gateway)
    store.create_order({
        "client_order_id": "legacy-live-order",
        "mode": "live",
        "symbol": "BTC/INR",
        "side": "buy",
        "order_type": "limit",
        "amount": Decimal("0.001"),
        "price": Decimal("100"),
        "filled": Decimal("0"),
        "status": "open",
        "exchange_order_id": "ZEB-LEGACY-1",
        "raw": {},
    })
    with pytest.raises(LiveTradingDisabled, match="cancellation is fail-closed"):
        service.cancel_order("legacy-live-order", "BTC/INR")
    assert gateway.cancelled == []
    assert store.get_order("legacy-live-order")["status"] == "open"
