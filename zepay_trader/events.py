from __future__ import annotations

import asyncio
import time
from typing import Any


class LiveEventHub:
    """Thread-safe bridge from sync exchange code to authenticated browser WebSockets."""

    def __init__(self, queue_size: int = 256):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue[dict[str, Any]]] = set()
        self._queue_size = queue_size

    def bind_loop(self) -> None:
        self._loop = asyncio.get_running_loop()

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        if self._loop is None:
            self.bind_loop()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_size)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._queues.discard(queue)

    def publish(self, event_type: str, data: Any) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        event = {"type": event_type, "timestamp": time.time(), "data": data}
        loop.call_soon_threadsafe(self._broadcast, event)

    def _broadcast(self, event: dict[str, Any]) -> None:
        for queue in tuple(self._queues):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                continue

    @property
    def clients(self) -> int:
        return len(self._queues)
