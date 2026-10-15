from __future__ import annotations

import threading
import time
from datetime import timedelta
from typing import Any

from .config import Settings


class KronosUnavailable(RuntimeError):
    pass


class KronosAdapter:
    """Lazy bridge to the upstream shiyu-coder/Kronos predictor.

    Kronos weights and Torch are optional; loading is deferred until a forecast is
    requested. Forecasts are informational signals only and are never connected
    to order submission.
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self._lock = threading.Lock()
        self._predictor: Any | None = None
        self._pandas: Any | None = None
        self._torch: Any | None = None
        self._last_error: str | None = None

    @property
    def status(self) -> dict[str, object]:
        configured = self.settings.kronos_enabled
        path_ok = (self.settings.kronos_path / "model" / "__init__.py").is_file()
        return {
            "enabled": configured,
            "configured_path_exists": path_ok,
            "loaded": self._predictor is not None,
            "ready": configured and path_ok and self._predictor is not None,
            "message": self._last_error or (
                "Kronos is disabled" if not configured else
                "Connect or clone the Kronos source at KRONOS_PATH" if not path_ok else
                "Model loads on the first forecast request" if self._predictor is None else
                "Ready"
            ),
        }

    def _load(self) -> None:
        if self._predictor is not None:
            return
        with self._lock:
            if self._predictor is not None:
                return
            if not self.settings.kronos_enabled:
                raise KronosUnavailable("Kronos integration is disabled")
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

                device = self.settings.kronos_device
                if device.startswith("cuda") and not torch.cuda.is_available():
                    raise RuntimeError("KRONOS_DEVICE requests CUDA, but CUDA is unavailable")
                tokenizer = KronosTokenizer.from_pretrained(self.settings.kronos_tokenizer)
                model = Kronos.from_pretrained(self.settings.kronos_model)
                model = model.to(device)
                model.eval()
                self._predictor = KronosPredictor(model, tokenizer, max_context=512)
                self._pandas = pd
                self._torch = torch
                self._last_error = None
            except Exception as exc:
                self._last_error = f"Kronos could not be loaded: {exc.__class__.__name__}: {str(exc)[:220]}"
                raise KronosUnavailable(self._last_error) from exc

    def forecast(self, symbol: str, timeframe: str, candles: list[list[float]]) -> dict[str, object]:
        self._load()
        pd = self._pandas
        torch = self._torch
        if len(candles) < 20:
            raise KronosUnavailable("Kronos needs at least 20 historical candles")
        lookback = min(self.settings.kronos_lookback, len(candles), 512)
        sample = candles[-lookback:]
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
        pred_len = self.settings.kronos_pred_len
        y_timestamp = pd.Series([last_time + step * (index + 1) for index in range(pred_len)])
        started = time.monotonic()
        try:
            with torch.inference_mode():
                prediction = self._predictor.predict(
                    df=x_df,
                    x_timestamp=x_timestamp,
                    y_timestamp=y_timestamp,
                    pred_len=pred_len,
                    T=1.0,
                    top_p=0.9,
                    sample_count=1,
                    verbose=False,
                )
            predicted_close = float(prediction["close"].iloc[-1])
        except Exception as exc:
            self._last_error = f"Kronos forecast failed: {exc.__class__.__name__}: {str(exc)[:220]}"
            raise KronosUnavailable(self._last_error) from exc
        current_close = float(sample[-1][4])
        change_pct = ((predicted_close / current_close) - 1.0) * 100 if current_close else 0.0
        direction = "up" if change_pct > 0.05 else "down" if change_pct < -0.05 else "flat"
        self._last_error = None
        return {
            "available": True,
            "symbol": symbol,
            "timeframe": timeframe,
            "current_close": current_close,
            "predicted_close": predicted_close,
            "predicted_change_pct": change_pct,
            "direction": direction,
            "prediction_steps": pred_len,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "model": self.settings.kronos_model,
            "disclaimer": "Research signal only. Forecasts are uncertain and do not place or recommend a trade.",
        }
