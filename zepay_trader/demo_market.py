from __future__ import annotations

import math
import time
from decimal import Decimal


TIMEFRAME_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}

# These are illustrative values for offline/paper preview only, never used for live orders.
ANCHORS = {
    "BTC/INR": 9_500_000.0,
    "ETH/INR": 315_000.0,
}


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper().replace("-", "/")


def _anchor(symbol: str) -> float:
    symbol = normalize_symbol(symbol)
    if symbol in ANCHORS:
        return ANCHORS[symbol]
    return 100_000.0


def _close_at(symbol: str, bucket: int) -> float:
    base = _anchor(symbol)
    wave = 0.0045 * math.sin(bucket / 27.0) + 0.0023 * math.sin(bucket / 7.0)
    drift = 0.000001 * math.sin(bucket / 250.0)
    return base * (1.0 + wave + drift)


def candles(symbol: str, timeframe: str = "5m", limit: int = 120, now_ms: int | None = None) -> list[list[float]]:
    symbol = normalize_symbol(symbol)
    step = TIMEFRAME_MS.get(timeframe)
    if step is None:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    now_ms = now_ms or int(time.time() * 1000)
    last_bucket = now_ms // step
    first_bucket = last_bucket - max(1, limit) + 1
    result: list[list[float]] = []
    for bucket in range(first_bucket, last_bucket + 1):
        open_price = _close_at(symbol, bucket - 1)
        close_price = _close_at(symbol, bucket)
        amplitude = max(close_price, open_price) * (0.0007 + 0.0003 * abs(math.sin(bucket / 4.0)))
        high = max(open_price, close_price) + amplitude
        low = min(open_price, close_price) - amplitude
        volume = 0.04 + 0.035 * (1.0 + math.sin(bucket / 5.0))
        result.append([
            float(bucket * step),
            round(open_price, 2),
            round(high, 2),
            round(low, 2),
            round(close_price, 2),
            round(volume, 8),
        ])
    return result


def ticker(symbol: str, now_ms: int | None = None) -> dict[str, object]:
    symbol = normalize_symbol(symbol)
    now_ms = now_ms or int(time.time() * 1000)
    recent = candles(symbol, "5m", 288, now_ms)
    last = recent[-1][4]
    prior = recent[0][1]
    bid = last * (1.0 - 0.0001)
    ask = last * (1.0 + 0.0001)
    return {
        "symbol": symbol,
        "last": round(last, 2),
        "bid": round(bid, 2),
        "ask": round(ask, 2),
        "high": round(max(row[2] for row in recent), 2),
        "low": round(min(row[3] for row in recent), 2),
        "percentage": round(((last / prior) - 1.0) * 100.0, 3) if prior else 0.0,
        "base_volume": round(sum(row[5] for row in recent), 6),
        "timestamp": now_ms,
        "source": "simulated",
        "is_simulated": True,
    }


def quote_amount(amount: Decimal, price: Decimal) -> Decimal:
    return amount * price
