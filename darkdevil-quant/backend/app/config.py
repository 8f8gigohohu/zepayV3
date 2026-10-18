"""DarkDevil Quant configuration.

All secrets come from environment variables. The defaults below exist ONLY for
local development and tests; production deployments MUST set DJQ_SECRET_KEY.
"""
import os
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DJQ_", env_file=".env", extra="ignore")

    app_name: str = "DarkDevil Quant"
    environment: str = "development"  # development | production

    # --- Persistence ---------------------------------------------------
    # Dev default is SQLite (zero-config). Production uses Postgres, e.g.
    # DATABASE_URL=postgresql+asyncpg://djq:pw@db:5432/darkdevil
    database_url: str = "sqlite+aiosqlite:///./data/darkdevil.db"

    # --- Security ------------------------------------------------------
    secret_key: str = ""  # REQUIRED outside development; used to derive Fernet key + JWT signing
    access_token_exp_minutes: int = 720
    cookie_secure: bool = False  # Set DJQ_COOKIE_SECURE=true when served over HTTPS.

    # --- Exchanges -----------------------------------------------------
    # Binance base URLs. api.binance.com is geo-restricted in some regions (HTTP 451);
    # data-api.binance.vision is Binance's OFFICIAL market-data-only endpoint.
    binance_rest_public_url: str = "https://data-api.binance.vision"
    binance_rest_private_url: str = "https://api.binance.com"
    binance_ws_market_url: str = "wss://data-stream.binance.vision"
    zebpay_rest_url: str = "https://sapi.zebpay.com"

    # --- Risk ----------------------------------------------------------
    # Live trading is HARD-DISABLED in Milestone 1. It is settable ONLY through
    # this env var and additionally requires the kill switch to be released;
    # order submission is further gated by adapter capability and risk checks.
    live_trading_enabled: bool = False
    kill_switch_default_active: bool = True
    max_order_notional_quote: float = 1_000.0
    max_daily_realized_loss_quote: float = 200.0
    max_open_position_notional_quote: float = 1_000.0

    # --- Misc ----------------------------------------------------------
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    http_timeout_seconds: float = 10.0
    user_agent: str = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_production and (not s.secret_key or len(s.secret_key) < 32):
        raise RuntimeError("DJQ_SECRET_KEY must be set (>=32 chars) in production")
    if s.is_production and not s.cookie_secure:
        raise RuntimeError("DJQ_COOKIE_SECURE must be true in production")
    return s


def secret_bytes(s: Settings) -> bytes:
    """Secret material for JWT signing, HKDFs etc. Dev-only fallback is explicit."""
    fallback = "dev-only-insecure-secret-change-me"
    raw = s.secret_key or fallback
    os.environ.setdefault("DJQ_DEV_INSECURE_DEFAULT_WARNING", "1") if not s.secret_key else None
    return raw.encode()
