from hummingbot.core.api_throttler.data_types import LinkedLimitWeightPair, RateLimit


DEFAULT_DOMAIN = "main"
BASE_URL = "https://sapi.zebpay.com"

# ZebPay Spot API routes (public API reference: github.com/zebpay/zebpay-api-references).
SYSTEM_TIME_PATH_URL = "api/v2/system/time"
SYSTEM_STATUS_PATH_URL = "api/v2/system/status"
EXCHANGE_INFO_PATH_URL = "api/v2/ex/exchangeInfo"
ORDER_BOOK_PATH_URL = "api/v2/market/orderbook"
TICKER_PATH_URL = "api/v2/market/ticker"
ALL_TICKERS_PATH_URL = "api/v2/market/allTickers"
BALANCE_PATH_URL = "api/v2/account/balance"
ORDERS_PATH_URL = "api/v2/ex/orders"
ORDER_PATH_URL = "api/v2/ex/order"
ORDER_FILLS_PATH_URL = "api/v2/ex/order/fills"
MY_FEE_PATH_URL = "api/v2/ex/myfee"  # append /{symbol}

MAX_ORDER_ID_LEN = 36
ORDER_STATES = {
    "OPEN": "OPEN",
    "ACTIVE": "OPEN",
    "NEW": "OPEN",
    "PARTIALLY_FILLED": "PARTIALLY_FILLED",
    "FILLED": "FILLED",
    "COMPLETED": "FILLED",
    "CLOSED": "FILLED",
    "CANCELED": "CANCELED",
    "CANCELLED": "CANCELED",
    "REJECTED": "FAILED",
    "EXPIRED": "FAILED",
}

# ZebPay's documented public/private limits are generous; this connector uses a
# conservative shared cap to leave headroom for other clients using the same key.
_GLOBAL_LIMIT = "ZebpayREST"


def _endpoint_limit(limit_id: str) -> RateLimit:
    return RateLimit(
        limit_id=limit_id,
        limit=8,
        time_interval=1,
        linked_limits=[LinkedLimitWeightPair(limit_id=_GLOBAL_LIMIT, weight=1)],
    )


RATE_LIMITS = [
    RateLimit(limit_id=_GLOBAL_LIMIT, limit=8, time_interval=1),
    *[_endpoint_limit(path) for path in (
        SYSTEM_TIME_PATH_URL,
        SYSTEM_STATUS_PATH_URL,
        EXCHANGE_INFO_PATH_URL,
        ORDER_BOOK_PATH_URL,
        TICKER_PATH_URL,
        ALL_TICKERS_PATH_URL,
        BALANCE_PATH_URL,
        ORDERS_PATH_URL,
        ORDER_PATH_URL,
        ORDER_FILLS_PATH_URL,
    )],
]
