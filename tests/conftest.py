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
            "jwt_secret": "test-jwt-secret-that-is-long-enough-for-live-gates-1234567890",
            "secure_cookie": False,
            "auto_live_trading_enabled": False,
            "cors_origins": ("http://localhost:5173",),
            "allowed_symbols": frozenset({"BTC/INR", "ETH/INR"}),
            "max_order_notional": Decimal("25000"),
            "max_daily_notional": Decimal("100000"),
            "max_open_orders": 8,
            "min_order_notional": Decimal("100"),
            "max_price_deviation_pct": Decimal("0.01"),
            "max_position_base": Decimal("0.001"),
            "max_daily_loss_quote": Decimal("5000"),
            "max_daily_trades": 50,
            "cooldown_after_loss_sec": 300,
            "circuit_breaker_pct": Decimal("0.05"),
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
