from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class LimitOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=3, max_length=24)
    side: Literal["buy", "sell"]
    order_type: Literal["limit"] = "limit"
    amount: Decimal = Field(gt=0, max_digits=30, decimal_places=16)
    price: Decimal = Field(gt=0, max_digits=30, decimal_places=12)

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


class StrategyStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: str | None = Field(default=None, max_length=128)


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr = Field(min_length=1, max_length=512)


class BootstrapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    setup_token: SecretStr = Field(min_length=1, max_length=256)
    api_key: SecretStr = Field(min_length=1, max_length=512)
    api_secret: SecretStr = Field(min_length=1, max_length=512)
    app_password: SecretStr = Field(min_length=12, max_length=512)
    password_confirmation: SecretStr = Field(min_length=12, max_length=512)


class CredentialUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: SecretStr = Field(min_length=1, max_length=512)
    api_secret: SecretStr = Field(min_length=1, max_length=512)


class ConnectionTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbol: str = Field(default="BTC/INR", min_length=3, max_length=24)


class LiveArmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    armed: bool


class PasswordChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: SecretStr = Field(min_length=1, max_length=512)
    new_password: SecretStr = Field(min_length=12, max_length=512)
    password_confirmation: SecretStr = Field(min_length=12, max_length=512)
