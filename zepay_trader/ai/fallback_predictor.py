from __future__ import annotations

from statistics import mean
_TIMEFRAME_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def predict(candles: list[list[float]], timeframe: str, horizon: int, window: int = 20) -> list[dict[str, float]]:
    """Deterministic EMA plus linear-momentum projection from real exchange candles."""
    if timeframe not in _TIMEFRAME_MS:
        raise ValueError(f"Unsupported forecast timeframe: {timeframe}")
    valid = [row for row in candles if len(row) >= 6 and float(row[4]) > 0]
    if len(valid) < max(5, min(window, 10)):
        raise ValueError("Fallback predictor needs at least 10 valid exchange candles")
    sample = valid[-max(5, window):]
    closes = [float(row[4]) for row in sample]
    highs = [float(row[2]) for row in sample]
    lows = [float(row[3]) for row in sample]
    volumes = [max(0.0, float(row[5])) for row in sample]

    alpha = 2.0 / (min(window, len(closes)) + 1.0)
    ema = closes[0]
    for close in closes[1:]:
        ema = alpha * close + (1.0 - alpha) * ema

    # Least-squares slope over the recent close series; no randomness or fabricated inputs.
    xs = list(range(len(closes)))
    x_mean = mean(xs)
    y_mean = mean(closes)
    denominator = sum((x - x_mean) ** 2 for x in xs)
    slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, closes)) / denominator if denominator else 0.0
    slope = max(-abs(ema) * 0.02, min(abs(ema) * 0.02, slope))
    candle_range = mean([max(0.0, high - low) for high, low in zip(highs, lows)])
    average_volume = mean(volumes)
    step_ms = _TIMEFRAME_MS[timeframe]
    timestamp = int(valid[-1][0])
    projected_close = ema
    result: list[dict[str, float]] = []

    for step in range(1, max(1, min(int(horizon), 64)) + 1):
        previous = closes[-1] if not result else result[-1]["close"]
        projected_close = max(ema * 0.01, ema + slope * step)
        volatility = max(candle_range * 0.5, abs(projected_close) * 0.0001)
        result.append({
            "timestamp": float(timestamp + step_ms * step),
            "open": float(previous),
            "high": float(max(previous, projected_close) + volatility),
            "low": float(max(0.0, min(previous, projected_close) - volatility)),
            "close": float(projected_close),
            "volume": float(average_volume),
        })
    return result
