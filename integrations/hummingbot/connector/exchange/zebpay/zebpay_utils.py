from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict

from pydantic import ConfigDict, Field, SecretStr

from hummingbot.client.config.config_data_types import BaseConnectorConfigMap
from hummingbot.core.data_type.trade_fee import TradeFeeSchema


CENTRALIZED = True
EXAMPLE_PAIR = "BTC-INR"
# ZebPay's spot exchange-info examples publish maker/taker fees of 0.45%.
# Configure a per-user override in Hummingbot if your account tier differs.
DEFAULT_FEES = TradeFeeSchema(
    maker_percent_fee_decimal=Decimal("0.0045"),
    taker_percent_fee_decimal=Decimal("0.0045"),
)


def is_exchange_information_valid(pair_info: Dict[str, Any]) -> bool:
    status = str(pair_info.get("status", "open")).lower()
    return pair_info.get("enableTrading", True) is not False and status in {"open", "trading", "active"}


class ZebpayConfigMap(BaseConnectorConfigMap):
    connector: str = "zebpay"
    zebpay_api_key: SecretStr = Field(
        default=...,
        json_schema_extra={
            "prompt": "Enter your ZebPay Spot API key",
            "is_secure": True,
            "is_connect_key": True,
            "prompt_on_new": True,
        },
    )
    zebpay_secret_key: SecretStr = Field(
        default=...,
        json_schema_extra={
            "prompt": "Enter your ZebPay Spot API secret",
            "is_secure": True,
            "is_connect_key": True,
            "prompt_on_new": True,
        },
    )
    model_config = ConfigDict(title="zebpay")


KEYS = ZebpayConfigMap.model_construct()
