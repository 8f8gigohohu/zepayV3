import pytest

from pydantic import ValidationError

from zepay_trader.runtime_config import RuntimeConfig, RuntimeConfigManager


def test_runtime_config_is_validated_and_atomically_persisted(tmp_path):
    path = tmp_path / 'config.yaml'
    manager = RuntimeConfigManager(path)
    config = manager.current()
    config.trading.symbol = 'ETH-INR'
    config.trading.loop_interval_sec = 45
    config.kronos.use_fallback = True
    saved = manager.update(config)

    reloaded = RuntimeConfigManager(path).current()
    assert saved.trading.symbol == 'ETH/INR'
    assert reloaded.trading.symbol == 'ETH/INR'
    assert reloaded.trading.loop_interval_sec == 45
    assert reloaded.trading.enabled is False


def test_runtime_config_rejects_unknown_fields_and_inconsistent_notional_limits():
    with pytest.raises(ValidationError):
        RuntimeConfig.model_validate({'trading': {'symbol': 'BTC/INR', 'unreviewed_setting': True}})
    with pytest.raises(ValidationError):
        RuntimeConfig.model_validate({'risk': {'max_order_notional_quote': 50000, 'max_daily_notional_quote': 1000}})
