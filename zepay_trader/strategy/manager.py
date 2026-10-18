from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from ..engine.order_engine import OrderEngine
from ..engine.position_manager import PositionManager
from ..engine.risk_engine import RiskEngine
from ..config import LIVE_ORDER_ROUTING_BLOCK_REASON
from ..events import LiveEventHub
from ..kronos import KronosAdapter
from ..runtime_config import RuntimeConfigManager
from ..trading import LiveTradingDisabled, TradingService
from .kronos_strategy import KronosStrategy

logger = logging.getLogger("zepay.strategy")


class StrategyManager:
    def __init__(
        self,
        service: TradingService,
        order_engine: OrderEngine,
        positions: PositionManager,
        risk: RiskEngine,
        kronos: KronosAdapter,
        config: RuntimeConfigManager,
        events: LiveEventHub,
        operator_is_valid: Callable[[str | None], bool],
    ):
        self.service = service
        self.order_engine = order_engine
        self.positions = positions
        self.risk = risk
        self.kronos = kronos
        self.config = config
        self.events = events
        self.operator_is_valid = operator_is_valid
        self._strategy: KronosStrategy | None = None
        self._task: asyncio.Task[None] | None = None
        self._reconcile_task: asyncio.Task[None] | None = None
        self._started_at: float | None = None
        self._last_error: str | None = None
        self._operator_token: str | None = None
        self._lock = asyncio.Lock()

    async def start(self, operator_token: str | None = None) -> dict:
        async with self._lock:
            if self.service.settings.trading_mode == "live":
                raise LiveTradingDisabled(
                    f"Autonomous live strategy is disabled: {LIVE_ORDER_ROUTING_BLOCK_REASON}"
                )
            if self.is_running:
                return self.status()
            if self.risk.state()["halted"]:
                raise RuntimeError("Risk engine is halted; review and resume risk controls before starting")

            runtime = self.config.current()
            self._operator_token = operator_token
            self._strategy = KronosStrategy(
                service=self.service,
                order_engine=self.order_engine,
                positions=self.positions,
                risk=self.risk,
                kronos=self.kronos,
                config=self.config,
                events=self.events,
                operator_is_valid=lambda: self.operator_is_valid(self._operator_token),
            )
            await self._strategy.on_start()
            runtime.trading.enabled = True
            self.config.update(runtime)
            self._started_at = time.time()
            self._last_error = None
            self._task = asyncio.create_task(self._run(), name="kronos-strategy-loop")
            self.events.publish("strategy_status", self.status())
            return self.status()

    async def stop(self, reason: str = "Stopped by operator") -> dict:
        async with self._lock:
            task = self._task
            self._task = None
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            if self._strategy is not None:
                await self._strategy.on_stop()
            runtime = self.config.current()
            runtime.trading.enabled = False
            self.config.update(runtime)
            self.events.publish("strategy_status", {**self.status(), "reason": reason})
            return self.status()

    async def emergency_stop(self) -> dict:
        self.risk.halt("Emergency stop requested by operator")
        await self.stop("Emergency stop")
        orders = await asyncio.to_thread(self.service.list_orders)
        canceled: list[str] = []
        failures: list[dict[str, str]] = []
        for order in orders:
            if order.get("status") not in {"open", "partially_filled"}:
                continue
            if self.service.settings.trading_mode == "live":
                failures.append({
                    "client_order_id": order["client_order_id"],
                    "error": ("Automatic ZebPay cancellation is disabled because the official cancel path "
                              "is unresolved; manage this order in ZebPay directly."),
                })
                continue
            try:
                result = await asyncio.to_thread(
                    self.order_engine.cancel,
                    order["client_order_id"],
                    order["symbol"],
                )
                canceled.append(result["client_order_id"])
            except Exception as exc:
                failures.append({"client_order_id": order["client_order_id"], "error": str(exc)[:240]})
        payload = {
            "halted": True,
            "strategy": self.status(),
            "canceled_order_ids": canceled,
            "cancellation_failures": failures,
            "positions_closed": False,
            "position_close_note": "No market/position-close endpoint is enabled; positions are left unchanged.",
        }
        self.events.publish("risk_alert", payload)
        return payload

    async def forecast_preview(self) -> dict:
        runtime = self.config.current()
        candles = await asyncio.to_thread(
            self.service.get_candles,
            runtime.trading.symbol,
            runtime.trading.timeframe,
            runtime.trading.candle_lookback,
        )
        forecast_payload: dict | None = None
        forecast_source = "ema_momentum_fallback"
        if self.kronos.enabled:
            try:
                forecast_payload = await asyncio.to_thread(
                    self.kronos.forecast,
                    runtime.trading.symbol,
                    runtime.trading.timeframe,
                    candles,
                    runtime.trading.predict_horizon,
                    runtime.trading.candle_lookback,
                )
                forecast_source = "kronos"
            except Exception:
                if not runtime.kronos.use_fallback:
                    raise
        if forecast_payload is not None:
            forecast = forecast_payload["forecast_candles"]
        else:
            if not runtime.kronos.use_fallback:
                raise KronosUnavailable("Kronos is disabled and fallback forecasting is disabled")
            from ..ai.fallback_predictor import predict
            forecast = predict(
                candles,
                runtime.trading.timeframe,
                runtime.trading.predict_horizon,
                runtime.kronos.fallback_window,
            )
        from ..ai.signal_generator import generate_signal
        signal = generate_signal(
            forecast,
            float(candles[-1][4]),
            runtime.trading.signal_threshold_buy,
            runtime.trading.signal_threshold_sell,
        )
        result = {
            **(forecast_payload or {}),
            "available": True,
            **signal,
            "symbol": runtime.trading.symbol,
            "timeframe": runtime.trading.timeframe,
            "prediction_steps": len(forecast),
            "forecast_candles": forecast,
            "source": forecast_source,
            "model": forecast_payload.get("model") if forecast_payload else None,
            "latency_ms": forecast_payload.get("latency_ms", 0) if forecast_payload else 0,
            "disclaimer": "Forecasts are uncertain statistical/model outputs from live ZebPay candles; not investment advice.",
        }
        self.events.publish("forecast_update", result)
        return result

    async def start_reconciliation(self) -> None:
        if self._reconcile_task is None or self._reconcile_task.done():
            self._reconcile_task = asyncio.create_task(self._reconcile_loop(), name="order-reconciliation")

    async def shutdown(self) -> None:
        await self.stop("Application shutdown")
        if self._reconcile_task is not None:
            self._reconcile_task.cancel()
            try:
                await self._reconcile_task
            except asyncio.CancelledError:
                pass
            self._reconcile_task = None

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict:
        return {
            "state": "running" if self.is_running else "stopped",
            "mode": self.service.settings.trading_mode,
            "uptime_seconds": max(0, int(time.time() - self._started_at)) if self._started_at else 0,
            "last_error": self._last_error,
            "strategy": self._strategy.status() if self._strategy else None,
            "tracked_orders": len(self.order_engine.tracker.all_orders()),
        }

    async def _run(self) -> None:
        try:
            while True:
                runtime = self.config.current()
                try:
                    assert self._strategy is not None
                    await self._strategy.on_tick()
                    self._last_error = None
                except asyncio.CancelledError:
                    raise
                except PermissionError as exc:
                    self._last_error = str(exc)
                    self.events.publish("risk_alert", {"message": self._last_error})
                    logger.warning("Strategy stopped: %s", self._last_error)
                    break
                except Exception as exc:
                    self._last_error = f"{exc.__class__.__name__}: {str(exc)[:240]}"
                    logger.exception("Strategy tick failed")
                    self.events.publish("log", {"level": "ERROR", "message": self._last_error})
                self.events.publish("strategy_status", self.status())
                await asyncio.sleep(runtime.trading.loop_interval_sec)
        except asyncio.CancelledError:
            raise
        finally:
            if self._strategy is not None:
                await self._strategy.on_stop()
            runtime = self.config.current()
            runtime.trading.enabled = False
            self.config.update(runtime)
            self.events.publish("strategy_status", self.status())

    async def _reconcile_loop(self) -> None:
        while True:
            try:
                orders = await self.order_engine.reconcile()
                self.events.publish("orders_snapshot", orders)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Order reconciliation error: %s", str(exc)[:240])
            await asyncio.sleep(5)
