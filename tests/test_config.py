import pytest

from zepay_trader.config import get_settings


def test_only_inr_quoted_symbols_are_accepted(monkeypatch):
    monkeypatch.setenv("ALLOWED_SYMBOLS", "BTC/USDT")
    with pytest.raises(ValueError, match="INR-quoted"):
        get_settings()


def test_private_settings_override_environment_and_never_store_live_arm(tmp_path, monkeypatch):
    from zepay_trader.private_settings import PrivateSettingsStore

    database_path = tmp_path / "secure-data" / "trading.sqlite3"
    settings_path = database_path.parent / "private_settings.json"
    monkeypatch.setenv("DATABASE_PATH", str(database_path))
    monkeypatch.setenv("TRADING_MODE", "live")
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "false")
    monkeypatch.setenv("ZEBPAY_API_KEY", "environment-key")
    monkeypatch.setenv("ZEBPAY_SECRET_KEY", "environment-secret")
    monkeypatch.delenv("PRIVATE_SETTINGS_PATH", raising=False)

    PrivateSettingsStore(settings_path).save(
        api_key="dashboard-key",
        api_secret="dashboard-secret",
        app_password="strong-operator-password",
        jwt_secret="dashboard-generated-jwt-secret-value-0123456789",
        secure_cookie=True,
    )
    settings = get_settings()
    assert settings.api_key == "dashboard-key"
    assert settings.api_secret == "dashboard-secret"
    assert settings.operator_auth_ready is True
    assert settings.live_trading_enabled is False
    assert settings.live_ready is False
    assert settings_path.stat().st_mode & 0o777 == 0o600
