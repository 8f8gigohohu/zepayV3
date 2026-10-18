from __future__ import annotations

from typing import Callable, Optional

from hummingbot.connector.exchange.zebpay import zebpay_constants as CONSTANTS
from hummingbot.connector.time_synchronizer import TimeSynchronizer
from hummingbot.connector.utils import TimeSynchronizerRESTPreProcessor
from hummingbot.core.api_throttler.async_throttler import AsyncThrottler
from hummingbot.core.web_assistant.auth import AuthBase
from hummingbot.core.web_assistant.connections.data_types import RESTMethod
from hummingbot.core.web_assistant.web_assistants_factory import WebAssistantsFactory


def public_rest_url(path_url: str, domain: str = CONSTANTS.DEFAULT_DOMAIN) -> str:
    return f"{CONSTANTS.BASE_URL}/{path_url.lstrip('/')}"


def private_rest_url(path_url: str, domain: str = CONSTANTS.DEFAULT_DOMAIN) -> str:
    return public_rest_url(path_url, domain)


def is_exchange_information_valid(pair_info: dict) -> bool:
    status = str(pair_info.get("status", "open")).lower()
    enabled = pair_info.get("enableTrading", True)
    return enabled is not False and status in {"open", "trading", "active"}


def build_api_factory(
    throttler: Optional[AsyncThrottler] = None,
    time_synchronizer: Optional[TimeSynchronizer] = None,
    time_provider: Optional[Callable] = None,
    auth: Optional[AuthBase] = None,
) -> WebAssistantsFactory:
    throttler = throttler or AsyncThrottler(CONSTANTS.RATE_LIMITS)
    synchronizer = time_synchronizer or TimeSynchronizer()
    provider = time_provider or (lambda: get_current_server_time(throttler))
    return WebAssistantsFactory(
        throttler=throttler,
        auth=auth,
        rest_pre_processors=[TimeSynchronizerRESTPreProcessor(synchronizer=synchronizer, time_provider=provider)],
    )


async def get_current_server_time(throttler: Optional[AsyncThrottler] = None) -> float:
    throttler = throttler or AsyncThrottler(CONSTANTS.RATE_LIMITS)
    factory = WebAssistantsFactory(throttler=throttler)
    assistant = await factory.get_rest_assistant()
    response = await assistant.execute_request(
        url=public_rest_url(CONSTANTS.SYSTEM_TIME_PATH_URL),
        method=RESTMethod.GET,
        throttler_limit_id=CONSTANTS.SYSTEM_TIME_PATH_URL,
    )
    milliseconds = response.get("time")
    if milliseconds is None:
        milliseconds = (response.get("data") or {}).get("timestamp")
    if milliseconds is None:
        raise IOError(f"Unexpected ZebPay server-time response: {response}")
    return float(milliseconds) / 1000.0
