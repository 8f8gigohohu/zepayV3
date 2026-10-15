from zepay_trader.exchange import ExchangeGateway


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
