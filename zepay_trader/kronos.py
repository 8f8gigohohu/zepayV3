from __future__ import annotations

import threading
import time
from datetime import timedelta
from typing import Any

from .config import Settings
from .runtime_config import KronosConfig


class KronosUnavailable(RuntimeError):
    pass


class KronosAdapter:
    """Lazy, cached adapter to the real shiyu-coder/Kronos predictor API."""

    def __init__(self, settings: Settings, config: KronosConfig | None = None):
        self.settings = settings
        self.config = config
        self.enabled = config.enabled if config is not None else settings.kronos_enabled
        self.model_name = config.predictor_model if config is not None else settings.kronos_model
        self.tokenizer_name = config.tokenizer_model if config is not None else settings.kronos_tokenizer
        self.device = config.device if config is not None else settings.kronos_device
        self.max_context = config.max_context if config is not None else 512
        self.lookback = config.max_context if config is not None else settings.kronos_lookback
        self.default_pred_len = settings.kronos_pred_len
        self.cache_seconds = config.cache_seconds if config is not None else 30
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._predictor: Any | None = None
        self._pandas: Any | None = None
        self._torch: Any | None = None
        self._last_error: str | None = None
        self._cache: dict[tuple[str, str, int, int], tuple[float, dict[str, Any]]] = {}

    def apply_config(self, config: KronosConfig) -> None:
        with self._load_lock, self._inference_lock:
            changed = (
                self.model_name != config.predictor_model
                or self.tokenizer_name != config.tokenizer_model
                or self.device != config.device
                or self.max_context != config.max_context
            )
            self.enabled = config.enabled
            self.model_name = config.predictor_model
            self.tokenizer_name = config.tokenizer_model
            self.device = config.device
            self.max_context = config.max_context
            self.lookback = config.max_context
            self.cache_seconds = config.cache_seconds
            if changed:
                self._predictor = None
                self._pandas = None
                self._torch = None
            self._cache.clear()

    @property
    def status(self) -> dict[str, object]:
        path_ok = (self.settings.kronos_path / "model" / "__init__.py").is_file()
        return {
            "enabled": self.enabled,
            "configured_path_exists": path_ok,
            "loaded": self._predictor is not None,
            "ready": self.enabled and path_ok and self._predictor is not None,
            "model": self.model_name,
            "device": self.device,
            "message": self._last_error or (
                "Kronos is disabled" if not self.enabled else
                "Kronos source checkout is not present" if not path_ok else
                "Model loads on first forecast" if self._predictor is None else
                "Ready"
            ),
        }

    def _load(self) -> None:
        if self._predictor is not None:
            return
        with self._load_lock:
            if self._predictor is not None:
                return
            if not self.enabled:
                raise KronosUnavailable("Kronos inference is disabled")
            model_dir = self.settings.kronos_path
            if not (model_dir / "model" / "__init__.py").is_file():
                raise KronosUnavailable(
                    f"Kronos source not found at {model_dir}; set KRONOS_PATH to a checkout of shiyu-coder/Kronos"
                )
            try:
                import sys
                import torch
                import pandas as pd

                path_string = str(model_dir.resolve())
                if path_string not in sys.path:
                    sys.path.insert(0, path_string)
                from model import Kronos, KronosPredictor, KronosTokenizer

                if self.device.startswith("cuda") and not torch.cuda.is_available():
                    raise RuntimeError("Configured CUDA device is unavailable")
                tokenizer = KronosTokenizer.from_pretrained(self.tokenizer_name)
                model = Kronos.from_pretrained(self.model_name).to(self.device)
                model.eval()
                self._predictor = KronosPredictor(model, tokenizer, max_context=self.max_context)
                self._pandas = pd
                self._torch = torch
                self._last_error = None
            except Exception as exc:
                self._last_error = f"Kronos load failed: {exc.__class__.__name__}: {str(exc)[:220]}"
                raise KronosUnavailable(self._last_error) from exc

    def forecast(
        self,
        symbol: str,
        timeframe: str,
        candles: list[list[float]],
        pred_len: int | None = None,
        lookback: int | None = None,
    ) -> dict[str, Any]:
        self._load()
        if len(candles) < 20:
            raise KronosUnavailable("Kronos needs at least 20 historical candles")
        prediction_length = max(1, min(int(pred_len or self.default_pred_len), 64))
        context_length = max(20, min(int(lookback or self.lookback), len(candles), self.max_context))
        sample = candles[-context_length:]
        last_timestamp = int(float(sample[-1][0]))
        key = (symbol, timeframe, prediction_length, last_timestamp)
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and now - cached[0] <= self.cache_seconds:
            return {**cached[1], "cache_hit": True}

        pd = self._pandas
        torch = self._torch
        frame = pd.DataFrame(sample, columns=["timestamp", "open", "high", "low", "close", "volume"])
        frame["timestamps"] = pd.to_datetime(frame["timestamp"], unit="ms", utc=True).dt.tz_localize(None)
        x_df = frame[["open", "high", "low", "close", "volume"]].copy()
        x_df["amount"] = x_df["close"] * x_df["volume"]
        x_timestamp = frame["timestamps"]
        last_time = x_timestamp.iloc[-1]
        step = {
            "1m": timedelta(minutes=1), "5m": timedelta(minutes=5), "15m": timedelta(minutes=15),
            "1h": timedelta(hours=1), "4h": timedelta(hours=4), "1d": timedelta(days=1),
        }.get(timeframe)
        if step is None:
            raise KronosUnavailable(f"Unsupported Kronos timeframe: {timeframe}")
        y_timestamp = pd.Series([last_time + step * (index + 1) for index in range(prediction_length)])
        started = time.monotonic()
        try:
            with self._inference_lock, torch.inference_mode():
                prediction = self._predictor.predict(
                    df=x_df,
                    x_timestamp=x_timestamp,
                    y_timestamp=y_timestamp,
                    pred_len=prediction_length,
                    T=1.0,
                    top_p=0.9,
                    sample_count=1,
                    verbose=False,
                )
            if prediction is None or len(prediction) == 0 or "close" not in prediction:
                raise ValueError("Kronos returned an empty forecast")
            forecast_candles = []
            for index, (_, row) in enumerate(prediction.iterrows()):
                future_timestamp = int(y_timestamp.iloc[index].timestamp() * 1000)
                forecast_candles.append({
                    "timestamp": future_timestamp,
                    "open": float(row.get("open", row["close"])),
                    "high": float(row.get("high", row["close"])),
                    "low": float(row.get("low", row["close"])),
                    "close": float(row["close"]),
                    "volume": float(row.get("volume", 0.0)),
                })
            predicted_close = float(prediction["close"].iloc[-1])
        except Exception as exc:
            self._last_error = f"Kronos inference failed: {exc.__class__.__name__}: {str(exc)[:220]}"
            raise KronosUnavailable(self._last_error) from exc

        current_close = float(sample[-1][4])
        change_pct = ((predicted_close / current_close) - 1.0) * 100 if current_close else 0.0
        result = {
            "available": True,
            "symbol": symbol,
            "timeframe": timeframe,
            "current_close": current_close,
            "predicted_close": predicted_close,
            "predicted_change_pct": change_pct,
            "direction": "up" if change_pct > 0.05 else "down" if change_pct < -0.05 else "flat",
            "prediction_steps": prediction_length,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "model": self.model_name,
            "source": "kronos",
            "forecast_candles": forecast_candles,
            "cache_hit": False,
            "disclaimer": "Model forecasts are uncertain; they are not investment advice and never place orders by themselves.",
        }
        self._last_error = None
        if self.cache_seconds > 0:
            self._cache[key] = (time.monotonic(), result)
        return result
