import pytest

from zepay_trader.config import get_settings


def test_only_inr_quoted_symbols_are_accepted(monkeypatch):
    monkeypatch.setenv("ALLOWED_SYMBOLS", "BTC/USDT")
    with pytest.raises(ValueError, match="INR-quoted"):
        get_settings()
