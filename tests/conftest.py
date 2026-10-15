from decimal import Decimal

import pytest

from zepay_trader.config import Settings


@pytest.fixture
def settings_factory(tmp_path):
    def make(**overrides):
        values = {
            "trading_mode": "paper",
            "live_trading_enabled": False,
            "api_key": "",
            "api_secret": "",
            "app_password": "",
            "secure_cookie": False,
            "allowed_symbols": frozenset({"BTC/INR", "ETH/INR"}),
            "max_order_notional": Decimal("25000"),
            "max_daily_notional": Decimal("100000"),
            "max_open_orders": 8,
            "min_order_notional": Decimal("100"),
            "max_price_deviation_pct": Decimal("0.01"),
            "paper_starting_inr": Decimal("500000"),
            "database_path": tmp_path / "test.sqlite3",
            "kronos_enabled": False,
            "kronos_path": tmp_path / "Kronos",
            "kronos_model": "NeoQuasar/Kronos-small",
            "kronos_tokenizer": "NeoQuasar/Kronos-Tokenizer-base",
            "kronos_device": "cpu",
            "kronos_lookback": 128,
            "kronos_pred_len": 3,
        }
        values.update(overrides)
        return Settings(**values)
    return make
