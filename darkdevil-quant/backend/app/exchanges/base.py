"""Value types shared by every exchange adapter.

The adapter contract covers SPOT and public market data in Milestone 1.
Anything not wired to a verified official API carries an explicit status -
adapters may never claim connectivity they do not have.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum


class CapabilityStatus(StrEnum):
    VERIFIED_LIVE = "verified_live"          # exercised against the official API from this deployment
    VERIFIED_DOCS = "verified_docs"          # implemented per current official docs; not exercised live
    NEEDS_VERIFICATION = "needs_verification"  # external blocker (docs incomplete, geo, credentials)
    NOT_IMPLEMENTED = "not_implemented"      # not written yet
    UNSUPPORTED = "unsupported"              # upstream does not offer the capability


@dataclass(frozen=True)
class Capability:
    status: CapabilityStatus
    detail: str = ""


@dataclass(frozen=True)
class Kline:
    open_time_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time_ms: int


@dataclass(frozen=True)
class Level:
    price: float
    quantity: float


@dataclass(frozen=True)
class OrderBook:
    bids: list[Level]
    asks: list[Level]
    ts_ms: int


@dataclass(frozen=True)
class Trade:
    id: str
    price: float
    quantity: float
    ts_ms: int
    buyer_is_maker: bool


@dataclass(frozen=True)
class Ticker:
    symbol: str
    last: float
    bid: float | None
    ask: float | None
    high: float | None
    low: float | None
    open: float | None
    change_pct: float | None
    base_volume: float | None
    quote_volume: float | None
    ts_ms: int


@dataclass
class Envelope:
    """Every API response carries provenance so the UI can label data origin + freshness."""
    exchange: str
    endpoint: str
    source_url: str
    ts_ms: int
    stale_after_ms: int
    data: object
    upstream_ts_ms: int | None = None
    verified: CapabilityStatus = CapabilityStatus.VERIFIED_DOCS

    @property
    def age_ms(self) -> int:
        return now_ms() - self.ts_ms


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


# Interval -> (min ms). Adapters normalize interval strings; unknown -> error.
INTERVAL_MS: dict[str, int] = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
    "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "1w": 604_800_000,
}
