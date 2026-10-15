from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LimitOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=3, max_length=24)
    side: Literal["buy", "sell"]
    order_type: Literal["limit"] = "limit"
    amount: Decimal = Field(gt=0, max_digits=30, decimal_places=16)
    price: Decimal = Field(gt=0, max_digits=30, decimal_places=12)
    live_confirmation: str | None = None

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        normalized = value.strip().upper().replace("-", "/")
        if normalized.count("/") != 1:
            raise ValueError("Use a spot symbol such as BTC/INR")
        base, quote = normalized.split("/", 1)
        if not base.isalnum() or not quote.isalnum():
            raise ValueError("Invalid spot symbol")
        return normalized

    @field_validator("amount", "price")
    @classmethod
    def finite_positive_decimal(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value <= 0:
            raise ValueError("Amount and price must be finite positive numbers")
        return value


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=512)
