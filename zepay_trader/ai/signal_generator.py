from __future__ import annotations

from typing import Any


def generate_signal(
    forecast: list[dict[str, float]],
    last_close: float,
    buy_threshold: float = 0.002,
    sell_threshold: float = -0.002,
) -> dict[str, Any]:
    if not forecast or last_close <= 0:
        return {
            "signal": "HOLD",
            "confidence": 0.0,
            "expected_return": 0.0,
            "predicted_close": None,
        }
    predicted_close = float(forecast[-1].get("close", 0.0))
    if predicted_close <= 0:
        return {
            "signal": "HOLD",
            "confidence": 0.0,
            "expected_return": 0.0,
            "predicted_close": None,
        }
    expected_return = predicted_close / float(last_close) - 1.0
    confidence = min(abs(expected_return) / 0.01, 1.0)
    signal = "BUY" if expected_return > buy_threshold else "SELL" if expected_return < sell_threshold else "HOLD"
    return {
        "signal": signal,
        "confidence": confidence,
        "expected_return": expected_return,
        "predicted_close": predicted_close,
    }
