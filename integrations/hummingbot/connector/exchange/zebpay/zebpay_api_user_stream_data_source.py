from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

from hummingbot.core.data_type.user_stream_tracker_data_source import UserStreamTrackerDataSource

if TYPE_CHECKING:
    from hummingbot.connector.exchange.zebpay.zebpay_exchange import ZebpayExchange


class ZebpayPollingUserStreamDataSource(UserStreamTrackerDataSource):
    """Hummingbot tracker keepalive for a REST-only spot connector.

    ZebPay Spot's published API reference does not specify a private websocket
    stream. Order fills, order states, and balances are therefore polled over
    signed REST by ZebpayExchange; this source only tells Hummingbot the tracker
    is running and does not synthesize exchange events.
    """

    POLL_HEARTBEAT_SECONDS = 5.0

    def __init__(self, connector: "ZebpayExchange"):
        super().__init__()
        self._connector = connector
        self._last_poll_time = 0.0

    @property
    def last_recv_time(self) -> float:
        return self._last_poll_time

    async def listen_for_user_stream(self, output: asyncio.Queue):
        while True:
            try:
                self._last_poll_time = time.time()
                output.put_nowait({"event": "rest_poll_heartbeat", "timestamp": self._last_poll_time})
                await self._sleep(self.POLL_HEARTBEAT_SECONDS)
            except asyncio.CancelledError:
                raise
