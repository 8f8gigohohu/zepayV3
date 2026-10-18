from decimal import Decimal

import ccxt
import pytest

import zepay_trader.exchange as exchange_module
from zepay_trader.exchange import ExchangeGateway, ExchangeUnavailable


class FakeCCXTClient:
    def load_markets(self):
        return {}

    def fetch_ticker(self, symbol):
        return {
            "symbol": symbol,
            "last": 10,
            "bid": None,
            "ask": None,
            "info": {"bestBid": "9.9", "bestAsk": "10.1", "priceChangePercent": "1.5", "vol": "4"},
        }

    def fetch_balance(self):
        return {"free": {"INR": "1000"}, "used": {}, "total": {"INR": "1000"}}

    def market(self, symbol):
        return {
            "symbol": symbol,
            "active": None,
            "base": "BTC",
            "quote": "INR",
            "precision": {"amount": 0.00000001, "price": 0.01},
            "limits": {"amount": {"min": None}, "cost": {"min": None}},
            "info": {
                "symbol": "BTC-INR", "status": "Open", "enableTrading": True,
                "lotSz": "0.00000001", "quoteMinSize": "100",
            },
        }


def test_ticker_maps_zebpay_raw_best_bid_and_ask(settings_factory):
    settings = settings_factory()
    gateway = ExchangeGateway(settings, client_factory=lambda _private: FakeCCXTClient())
    quote = gateway.ticker("BTC/INR")
    assert quote["bid"] == 9.9
    assert quote["ask"] == 10.1
    assert quote["percentage"] == 1.5
    assert quote["base_volume"] == 4
    assert quote["is_simulated"] is False

    market = gateway.market("BTC/INR")
    assert market["active"] is True
    assert market["minimum_amount"] == 0.00000001
    assert market["minimum_notional"] == 100


def test_connection_check_reads_public_and_private_data_without_submitting_orders(settings_factory):
    settings = settings_factory()
    gateway = ExchangeGateway(settings, client_factory=lambda _private: FakeCCXTClient())
    result = gateway.test_connection("BTC/INR")
    assert result["ok"] is True
    assert result["market_data"]["ok"] is True
    assert result["private_account"]["ok"] is True
    assert result["private_account"]["assets_returned"] == 1
    assert result["orders_submitted"] == 0


def test_transient_reads_retry_but_live_writes_never_call_ccxt(settings_factory, monkeypatch):
    settings = settings_factory()
    monkeypatch.setattr(exchange_module.time, 'sleep', lambda _seconds: None)

    class FlakyReadClient(FakeCCXTClient):
        def __init__(self):
            self.calls = 0

        def fetch_ticker(self, symbol):
            self.calls += 1
            if self.calls < 3:
                raise ccxt.NetworkError('temporary network failure')
            return super().fetch_ticker(symbol)

    read_client = FlakyReadClient()
    read_gateway = ExchangeGateway(settings, client_factory=lambda _private: read_client, max_retries=2)
    assert read_gateway.ticker('BTC/INR')['last'] == 10
    assert read_client.calls == 3

    class WriteClient(FakeCCXTClient):
        def __init__(self):
            self.calls = 0

        def create_order(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError('CCXT create_order must not be called')

        def cancel_order(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError('CCXT cancel_order must not be called')

    write_client = WriteClient()
    write_gateway = ExchangeGateway(settings, client_factory=lambda _private: write_client, max_retries=4)
    with pytest.raises(ExchangeUnavailable, match='placement is disabled'):
        write_gateway.place_limit_order('BTC/INR', 'buy', Decimal('0.1'), Decimal('10'), 'client-1')
    with pytest.raises(ExchangeUnavailable, match='cancellation is disabled'):
        write_gateway.cancel_order('exchange-order-1', 'BTC/INR')
    assert write_client.calls == 0
