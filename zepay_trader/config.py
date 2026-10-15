from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _decimal(name: str, default: str) -> Decimal:
    raw = os.getenv(name, default).strip()
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(f"{name} must be a decimal number") from exc
    if not value.is_finite() or value < 0:
        raise ValueError(f"{name} must be a finite, non-negative decimal number")
    return value


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _symbols() -> frozenset[str]:
    raw = os.getenv("ALLOWED_SYMBOLS", "BTC/INR,ETH/INR")
    result = set()
    for item in raw.split(","):
        normalized = item.strip().upper().replace("-", "/")
        if not normalized:
            continue
        if normalized.count("/") != 1:
            raise ValueError(f"Invalid symbol in ALLOWED_SYMBOLS: {item!r}")
        base, quote = normalized.split("/", 1)
        if not base.isalnum() or not quote.isalnum():
            raise ValueError(f"Invalid symbol in ALLOWED_SYMBOLS: {item!r}")
        if quote != "INR":
            raise ValueError("This trading desk currently supports INR-quoted spot markets only")
        result.add(normalized)
    if not result:
        raise ValueError("ALLOWED_SYMBOLS must contain at least one spot pair")
    return frozenset(result)


@dataclass(frozen=True, slots=True)
class Settings:
    trading_mode: str
    live_trading_enabled: bool
    api_key: str
    api_secret: str
    app_password: str
    secure_cookie: bool
    allowed_symbols: frozenset[str]
    max_order_notional: Decimal
    max_daily_notional: Decimal
    max_open_orders: int
    min_order_notional: Decimal
    max_price_deviation_pct: Decimal
    paper_starting_inr: Decimal
    database_path: Path
    kronos_enabled: bool
    kronos_path: Path
    kronos_model: str
    kronos_tokenizer: str
    kronos_device: str
    kronos_lookback: int
    kronos_pred_len: int

    @property
    def has_api_credentials(self) -> bool:
        return bool(self.api_key and self.api_secret)

    @property
    def live_ready(self) -> bool:
        """True only after the operator deliberately arms every live-trading gate."""
        return (
            self.trading_mode == "live"
            and self.live_trading_enabled
            and self.has_api_credentials
            and len(self.app_password) >= 12
            and self.secure_cookie
        )

    @property
    def requires_operator_login(self) -> bool:
        return self.trading_mode == "live"

    def public_view(self) -> dict[str, object]:
        # Never return API key, secret, or password to the browser.
        return {
            "mode": self.trading_mode,
            "live_ready": self.live_ready,
            "credentials_configured": self.has_api_credentials,
            "operator_password_configured": len(self.app_password) >= 12,
            "allowed_symbols": sorted(self.allowed_symbols),
            "risk": {
                "max_order_notional": str(self.max_order_notional),
                "max_daily_notional": str(self.max_daily_notional),
                "max_open_orders": self.max_open_orders,
                "minimum_notional": str(self.min_order_notional),
                "max_price_deviation_pct": str(self.max_price_deviation_pct),
            },
            "kronos_enabled": self.kronos_enabled,
        }


def get_settings() -> Settings:
    mode = os.getenv("TRADING_MODE", "paper").strip().lower()
    if mode not in {"paper", "live"}:
        raise ValueError("TRADING_MODE must be either 'paper' or 'live'")

    db_path_raw = Path(os.getenv("DATABASE_PATH", "data/zepay.sqlite3")).expanduser()
    if not db_path_raw.is_absolute():
        db_path_raw = ROOT / db_path_raw
    kronos_path_raw = Path(os.getenv("KRONOS_PATH", "models/Kronos")).expanduser()
    if not kronos_path_raw.is_absolute():
        kronos_path_raw = ROOT / kronos_path_raw

    return Settings(
        trading_mode=mode,
        live_trading_enabled=_bool("LIVE_TRADING_ENABLED", False),
        api_key=os.getenv("ZEBPAY_API_KEY", "").strip(),
        api_secret=os.getenv("ZEBPAY_SECRET_KEY", "").strip(),
        app_password=os.getenv("APP_PASSWORD", ""),
        secure_cookie=_bool("SECURE_COOKIE", False),
        allowed_symbols=_symbols(),
        max_order_notional=_decimal("MAX_ORDER_NOTIONAL", "25000"),
        max_daily_notional=_decimal("MAX_DAILY_NOTIONAL", "100000"),
        max_open_orders=_positive_int("MAX_OPEN_ORDERS", 8),
        min_order_notional=_decimal("MIN_ORDER_NOTIONAL", "100"),
        max_price_deviation_pct=_decimal("MAX_PRICE_DEVIATION_PCT", "0.01"),
        paper_starting_inr=_decimal("PAPER_STARTING_INR", "500000"),
        database_path=db_path_raw,
        kronos_enabled=_bool("KRONOS_ENABLED", False),
        kronos_path=kronos_path_raw,
        kronos_model=os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-small").strip(),
        kronos_tokenizer=os.getenv("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base").strip(),
        kronos_device=os.getenv("KRONOS_DEVICE", "cpu").strip(),
        kronos_lookback=_positive_int("KRONOS_LOOKBACK", 128),
        kronos_pred_len=_positive_int("KRONOS_PRED_LEN", 3),
    )
