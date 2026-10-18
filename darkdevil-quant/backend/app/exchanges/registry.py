"""Adapter registry. Adding an exchange = implement the adapter contract + register here
with an honest status label; no implicit 'connected' assumptions anywhere."""
from functools import lru_cache

from ..config import get_settings
from .base import CapabilityStatus
from .binance import BinanceAdapter
from .zebpay import ZebPayAdapter

KNOWN_EXCHANGES: tuple[str, ...] = ("binance", "zebpay")


@lru_cache
def get_adapter(exchange: str):
    s = get_settings()
    if exchange == "binance":
        return BinanceAdapter(s.binance_rest_public_url, s.binance_rest_private_url)
    if exchange == "zebpay":
        return ZebPayAdapter(s.zebpay_rest_url)
    raise KeyError(f"no adapter registered for exchange {exchange!r}")


def get_adapter_notes(exchange: str) -> dict:
    """Read current adapter capability state; dynamic live verification is not cached."""
    a = get_adapter(exchange)
    caps = a.capabilities
    best = CapabilityStatus
    return {
        "exchange": exchange,
        "capabilities": {k: {"status": c.status.value, "detail": c.detail} for k, c in caps.items()},
        "overall": ("live_public_data" if any(c.status == best.VERIFIED_LIVE for c in caps.values())
                    else "unverified"),
    }


def list_exchanges() -> list[dict]:
    return [get_adapter_notes(e) for e in KNOWN_EXCHANGES]
