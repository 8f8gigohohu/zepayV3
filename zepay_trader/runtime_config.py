from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import ROOT


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class ExchangeConfig(StrictModel):
    name: Literal["zebpay"] = "zebpay"
    spot_base_url: str = "https://sapi.zebpay.com"
    api_version: Literal["v2"] = "v2"
    rate_limit_ms: int = Field(default=250, ge=50, le=10_000)
    max_retries: int = Field(default=4, ge=0, le=4)


class TradingConfig(StrictModel):
    symbol: str = "BTC/INR"
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "1m"
    candle_lookback: int = Field(default=200, ge=50, le=512)
    predict_horizon: int = Field(default=24, ge=1, le=64)
    signal_threshold_buy: float = Field(default=0.002, gt=0, le=0.1)
    signal_threshold_sell: float = Field(default=-0.002, ge=-0.1, lt=0)
    min_confidence: float = Field(default=0.5, ge=0, le=1)
    order_type: Literal["LIMIT"] = "LIMIT"
    limit_offset_pct: float = Field(default=0.0005, ge=0, le=0.01)
    order_size_base: float = Field(default=0.0001, gt=0)
    loop_interval_sec: int = Field(default=60, ge=5, le=3600)
    max_open_orders: int = Field(default=3, ge=1, le=100)
    enabled: bool = False

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        normalized = value.strip().upper().replace("-", "/")
        if normalized.count("/") != 1 or not normalized.endswith("/INR"):
            raise ValueError("This terminal currently supports INR-quoted spot symbols only")
        base = normalized.split("/", 1)[0]
        if not base.isalnum():
            raise ValueError("Invalid trading symbol")
        return normalized


class KronosConfig(StrictModel):
    enabled: bool = False
    tokenizer_model: str = "NeoQuasar/Kronos-Tokenizer-base"
    predictor_model: str = "NeoQuasar/Kronos-base"
    device: str = "cpu"
    max_context: int = Field(default=512, ge=64, le=2048)
    use_fallback: bool = True
    fallback_window: int = Field(default=20, ge=5, le=200)
    cache_seconds: int = Field(default=30, ge=0, le=300)


class RiskConfig(StrictModel):
    max_position_base: float = Field(default=0.001, gt=0)
    max_daily_loss_quote: float = Field(default=5000, gt=0)
    max_daily_trades: int = Field(default=50, ge=1, le=10_000)
    cooldown_after_loss_sec: int = Field(default=300, ge=0, le=86_400)
    circuit_breaker_pct: float = Field(default=0.05, gt=0, le=0.5)
    max_order_notional_quote: float = Field(default=25_000, gt=0)
    max_daily_notional_quote: float = Field(default=100_000, gt=0)


class PaperTradingConfig(StrictModel):
    enabled: bool = True
    starting_balance_quote: float = Field(default=500_000, gt=0)
    simulate_slippage_pct: float = Field(default=0.001, ge=0, le=0.05)


class LoggingConfig(StrictModel):
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    file: str = "logs/trading.log"
    max_bytes: int = Field(default=10_000_000, ge=100_000)
    backup_count: int = Field(default=5, ge=1, le=50)


class DatabaseConfig(StrictModel):
    url: str = "sqlite:///data/zepay.sqlite3"


class UIConfig(StrictModel):
    host: str = "0.0.0.0"
    port: int = Field(default=5173, ge=1, le=65535)
    refresh_interval_ms: int = Field(default=1000, ge=250, le=10_000)
    theme: Literal["dark"] = "dark"


class RuntimeConfig(StrictModel):
    exchange: ExchangeConfig = Field(default_factory=ExchangeConfig)
    trading: TradingConfig = Field(default_factory=TradingConfig)
    kronos: KronosConfig = Field(default_factory=KronosConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    paper_trading: PaperTradingConfig = Field(default_factory=PaperTradingConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    ui: UIConfig = Field(default_factory=UIConfig)

    @model_validator(mode="after")
    def consistent_limits(self) -> "RuntimeConfig":
        if self.risk.max_daily_notional_quote < self.risk.max_order_notional_quote:
            raise ValueError("max_daily_notional_quote must be at least max_order_notional_quote")
        return self


class RuntimeConfigManager:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path or (ROOT / "config.yaml")).resolve()
        self._lock = threading.RLock()
        self._config = self._load()

    def current(self) -> RuntimeConfig:
        with self._lock:
            return RuntimeConfig.model_validate(self._config.model_dump())

    def update(self, config: RuntimeConfig) -> RuntimeConfig:
        with self._lock:
            self._write(config)
            self._config = config
            return self.current()

    def _load(self) -> RuntimeConfig:
        if not self.path.is_file():
            return RuntimeConfig()
        with self.path.open("r", encoding="utf-8") as handle:
            raw = yaml.safe_load(handle) or {}
        return RuntimeConfig.model_validate(raw)

    def _write(self, config: RuntimeConfig) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rendered = yaml.safe_dump(config.model_dump(mode="json"), sort_keys=False, allow_unicode=True)
        fd, temp_path = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
        except Exception:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise
