from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from hummingbot.connector.exchange.zebpay import zebpay_constants as CONSTANTS
from hummingbot.connector.exchange.zebpay import zebpay_web_utils as web_utils
from hummingbot.core.data_type.order_book_message import OrderBookMessage, OrderBookMessageType
from hummingbot.core.data_type.order_book_tracker_data_source import OrderBookTrackerDataSource
from hummingbot.core.web_assistant.connections.data_types import RESTMethod
from hummingbot.core.web_assistant.web_assistants_factory import WebAssistantsFactory

if TYPE_CHECKING:
    from hummingbot.connector.exchange.zebpay.zebpay_exchange import ZebpayExchange


class ZebpayAPIOrderBookDataSource(OrderBookTrackerDataSource):
    """REST-polled order book source; ZebPay Spot's public REST docs are used."""

    SNAPSHOT_POLL_SECONDS = 5.0

    def __init__(
        self,
        trading_pairs: List[str],
        connector: "ZebpayExchange",
        api_factory: WebAssistantsFactory,
    ):
        super().__init__(trading_pairs)
        self._connector = connector
        self._api_factory = api_factory

    async def get_last_traded_prices(
        self, trading_pairs: List[str], domain: Optional[str] = None
    ) -> Dict[str, float]:
        return await self._connector.get_last_traded_prices(trading_pairs)

    async def _order_book_snapshot(self, trading_pair: str) -> OrderBookMessage:
        symbol = await self._connector.exchange_symbol_associated_to_pair(trading_pair)
        assistant = await self._api_factory.get_rest_assistant()
        response = await assistant.execute_request(
            url=web_utils.public_rest_url(CONSTANTS.ORDER_BOOK_PATH_URL),
            params={"symbol": symbol, "limit": 100},
            method=RESTMethod.GET,
            throttler_limit_id=CONSTANTS.ORDER_BOOK_PATH_URL,
        )
        data = response.get("data") or {}
        timestamp = float(data.get("timestamp") or time.time())
        if timestamp > 1e12:
            timestamp /= 1000.0
        update_id = int(data.get("nonce") or timestamp * 1000)
        return OrderBookMessage(
            OrderBookMessageType.SNAPSHOT,
            {
                "trading_pair": trading_pair,
                "update_id": update_id,
                "bids": data.get("bids") or [],
                "asks": data.get("asks") or [],
            },
            timestamp,
        )

    async def listen_for_subscriptions(self):
        # ZebPay Spot's published reference currently documents REST market data.
        # Poll snapshots instead of pretending that a websocket feed is available.
        while True:
            for trading_pair in list(self._trading_pairs):
                try:
                    snapshot = await self._order_book_snapshot(trading_pair)
                    self._message_queue[self._snapshot_messages_queue_key].put_nowait(snapshot)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.logger().exception(f"Failed to poll ZebPay order book for {trading_pair}")
            await self._sleep(self.SNAPSHOT_POLL_SECONDS)

    async def _parse_order_book_snapshot_message(self, raw_message: Any, message_queue: asyncio.Queue):
        if isinstance(raw_message, OrderBookMessage):
            message_queue.put_nowait(raw_message)
            return
        raise ValueError("Unexpected raw snapshot event from ZebPay REST poller")

    async def subscribe_to_trading_pair(self, trading_pair: str) -> bool:
        self.add_trading_pair(trading_pair)
        return True

    async def unsubscribe_from_trading_pair(self, trading_pair: str) -> bool:
        self.remove_trading_pair(trading_pair)
        return True
