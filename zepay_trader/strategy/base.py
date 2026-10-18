from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseStrategy(ABC):
    @abstractmethod
    async def on_tick(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def on_start(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def on_stop(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def status(self) -> dict[str, Any]:
        raise NotImplementedError
