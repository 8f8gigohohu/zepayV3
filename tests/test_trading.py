from decimal import Decimal

import pytest

from zepay_trader.demo_market import candles as demo_candles
from zepay_trader.exchange import SubmissionUncertain
from zepay_trader.kronos import KronosAdapter
from zepay_trader.risk import RiskViolation
from zepay_trader.schemas import LimitOrderRequest
from zepay_trader.storage import Store
from zepay_trader.trading import LIVE_CONFIRMATION_PHRASE, LiveTradingDisabled, TradingService


class FakeGateway:
    def __init__(self, quote=None):
        self.quote = quote or {
            "symbol": "BTC/INR", "last": 100.0, "bid": 99.9, "ask": 100.1,
            "high": 101.0, "low": 98.0, "percentage": 1.2,
            "source": "test", "is_simulated": False, "timestamp": 1_700_000_000_000,
        }
        self.submitted = []

    def ticker(self, symbol):
        return {**self.quote, "symbol": symbol}

    def candles(self, symbol, timeframe, limit):
        return demo_candles(symbol, timeframe, limit)

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

    def place_limit_order(self, symbol, side, amount, price, client_order_id):
        self.submitted.append((symbol, side, amount, price, client_order_id))
        return {"id": "ZEB-123", "status": "open", "filled": 0, "info": {"orderId": "ZEB-123"}}

    def cancel_order(self, exchange_order_id, symbol):
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


def test_live_mode_requires_secure_cookie_in_addition_to_credentials(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=False,
    )
    assert settings.live_ready is False


def test_live_order_fails_closed_without_best_side_quote(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=True,
    )
    quote = {
        "symbol": "BTC/INR", "last": 100.0, "bid": 99.9, "ask": None,
        "source": "test", "is_simulated": False,
    }
    service, _store = make_service(settings, FakeGateway(quote))
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101"),
        live_confirmation=LIVE_CONFIRMATION_PHRASE,
    )
    with pytest.raises(RiskViolation, match="valid best buy quote"):
        service.place_order(request, operator_authenticated=True)


def test_live_order_precision_is_rejected_instead_of_silently_changed(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=True,
    )
    gateway = FakeGateway()
    gateway.normalize_order = lambda _symbol, amount, _price: (amount, Decimal("100"))
    service, _store = make_service(settings, gateway)
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101.23"),
        live_confirmation=LIVE_CONFIRMATION_PHRASE,
    )
    with pytest.raises(RiskViolation, match="does not match ZebPay precision"):
        service.place_order(request, operator_authenticated=True)
    assert gateway.submitted == []


def test_ambiguous_live_submission_is_recorded_unknown_without_retry(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=True,
    )

    class TimeoutGateway(FakeGateway):
        def place_limit_order(self, *args):
            self.submitted.append(args)
            raise SubmissionUncertain("request timed out after submit")

    gateway = TimeoutGateway()
    service, store = make_service(settings, gateway)
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101"),
        live_confirmation=LIVE_CONFIRMATION_PHRASE,
    )
    with pytest.raises(SubmissionUncertain):
        service.place_order(request, operator_authenticated=True)
    orders = store.list_orders("live")
    assert len(orders) == 1
    assert orders[0]["status"] == "unknown"
    assert store.open_order_count("live") == 1
    assert len(gateway.submitted) == 1


def test_live_submission_requires_exact_confirmation_and_records_order(settings_factory):
    settings = settings_factory(
        trading_mode="live",
        live_trading_enabled=True,
        api_key="test-key",
        api_secret="test-secret",
        app_password="test-operator-password",
        secure_cookie=True,
    )
    gateway = FakeGateway()
    service, store = make_service(settings, gateway)
    request = LimitOrderRequest(
        symbol="BTC/INR", side="buy", amount=Decimal("1"), price=Decimal("101")
    )
    with pytest.raises(RiskViolation, match="exact per-order confirmation"):
        service.place_order(request, operator_authenticated=True)
    assert gateway.submitted == []

    confirmed = request.model_copy(update={"live_confirmation": LIVE_CONFIRMATION_PHRASE})
    order = service.place_order(confirmed, operator_authenticated=True)
    assert order["mode"] == "live"
    assert order["exchange_order_id"] == "ZEB-123"
    assert order["status"] == "open"
    assert len(gateway.submitted) == 1
    assert store.open_order_count("live") == 1
