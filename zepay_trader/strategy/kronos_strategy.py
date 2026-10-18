from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Any, Callable

from ..ai.fallback_predictor import predict as fallback_predict
from ..ai.signal_generator import generate_signal
from ..engine.order_engine import OrderEngine
from ..engine.position_manager import PositionManager
from ..engine.risk_engine import RiskEngine
from ..events import LiveEventHub
from ..kronos import KronosAdapter, KronosUnavailable
from ..runtime_config import RuntimeConfigManager
from ..schemas import LimitOrderRequest
from ..trading import TradingService
from .base import BaseStrategy


class KronosStrategy(BaseStrategy):
    def __init__(
        self,
        service: TradingService,
        order_engine: OrderEngine,
        positions: PositionManager,
        risk: RiskEngine,
        kronos: KronosAdapter,
        config: RuntimeConfigManager,
        events: LiveEventHub,
        operator_is_valid: Callable[[], bool],
    ):
        self.service = service
        self.order_engine = order_engine
        self.positions = positions
        self.risk = risk
        self.kronos = kronos
        self.config_manager = config
        self.events = events
        self.operator_is_valid = operator_is_valid
        self._starting_equity = Decimal("0")
        self._last_tick: float | None = None
        self._last_error: str | None = None
        self._latest_forecast: dict[str, Any] | None = None
        self._latest_signal: dict[str, Any] | None = None
        self._last_action = "idle"

    async def on_start(self) -> None:
        portfolio = await asyncio.to_thread(self.service.portfolio)
        equity = portfolio.get("equity_inr")
        if equity is None:
            raise RuntimeError("Cannot start a trading strategy without complete INR equity valuation")
        self._starting_equity = Decimal(str(equity))
        await asyncio.to_thread(self.service.get_market, self.config_manager.current().trading.symbol)
        self._last_error = None
        self._last_action = "started"

    async def on_tick(self) -> None:
        config = self.config_manager.current()
        trading = config.trading
        if not trading.enabled:
            self._last_action = "strategy disabled in runtime config"
            return
        if self.service.settings.trading_mode == "live" and not self.operator_is_valid():
            raise PermissionError("Live operator session expired; strategy stopped before another order")

        candles = await asyncio.to_thread(
            self.service.get_candles, trading.symbol, trading.timeframe, trading.candle_lookback
        )
        if len(candles) < 20:
            raise RuntimeError("Strategy requires at least 20 real ZebPay candles")
        quote = await asyncio.to_thread(self.service.get_market, trading.symbol)
        if quote.get("is_simulated") is not False:
            raise RuntimeError("Strategy is fail-closed: exchange market data must be verified as real")

        forecast_source = "kronos"
        forecast_payload: dict[str, Any] | None = None
        predicted_candles: list[dict[str, float]]
        if self.kronos.enabled:
            try:
                forecast_payload = await asyncio.to_thread(
                    self.kronos.forecast,
                    trading.symbol,
                    trading.timeframe,
                    candles,
                    trading.predict_horizon,
                    trading.candle_lookback,
                )
                predicted_candles = forecast_payload["forecast_candles"]
                forecast_source = "kronos"
            except KronosUnavailable:
                if not config.kronos.use_fallback:
                    raise
                predicted_candles = fallback_predict(
                    candles,
                    trading.timeframe,
                    trading.predict_horizon,
                    config.kronos.fallback_window,
                )
                forecast_source = "ema_momentum_fallback"
        else:
            if not config.kronos.use_fallback:
                raise KronosUnavailable("Kronos is disabled and fallback forecasting is disabled")
            predicted_candles = fallback_predict(
                candles,
                trading.timeframe,
                trading.predict_horizon,
                config.kronos.fallback_window,
            )
            forecast_source = "ema_momentum_fallback"

        signal = generate_signal(
            predicted_candles,
            float(candles[-1][4]),
            trading.signal_threshold_buy,
            trading.signal_threshold_sell,
        )
        signal.update({
            "symbol": trading.symbol,
            "timeframe": trading.timeframe,
            "source": forecast_source,
            "forecast_candles": predicted_candles,
            "model": forecast_payload.get("model") if forecast_payload else None,
            "latency_ms": forecast_payload.get("latency_ms") if forecast_payload else 0,
        })
        self._latest_forecast = signal
        self._latest_signal = signal
        self._last_tick = asyncio.get_running_loop().time()
        self._last_error = None
        self.events.publish("forecast_update", signal)

        if signal["signal"] == "HOLD":
            self._last_action = "hold"
            self._log_tick(trading.symbol, candles[-1][4], signal, "hold")
            return
        if float(signal["confidence"]) < trading.min_confidence:
            self._last_action = "confidence below threshold"
            self._log_tick(trading.symbol, candles[-1][4], signal, "skipped_low_confidence")
            return

        position = self.positions.get_position(trading.symbol)
        position_amount = Decimal(str(position["amount"])) if position else Decimal("0")
        side = "buy" if signal["signal"] == "BUY" else "sell"
        amount = Decimal(str(trading.order_size_base))
        if side == "sell":
            amount = min(position_amount, amount)
            if amount <= 0:
                self._last_action = "sell signal with no tracked position"
                self._log_tick(trading.symbol, candles[-1][4], signal, "skipped_no_position")
                return
        ask = Decimal(str(quote.get("ask") or quote["last"]))
        bid = Decimal(str(quote.get("bid") or quote["last"]))
        offset = Decimal(str(trading.limit_offset_pct))
        price = ask * (Decimal("1") - offset) if side == "buy" else bid * (Decimal("1") + offset)
        order_intent = {"symbol": trading.symbol, "side": side, "amount": amount, "price": price}

        portfolio = await asyncio.to_thread(self.service.portfolio)
        equity = Decimal(str(portfolio["equity_inr"])) if portfolio.get("equity_inr") is not None else Decimal("0")
        allowed, reason = self.risk.check(
            order=order_intent,
            position=position_amount,
            equity=equity,
            starting_equity=self._starting_equity,
        )
        if not allowed:
            self._last_action = f"blocked: {reason}"
            self._log_tick(trading.symbol, candles[-1][4], signal, self._last_action)
            return

        request = LimitOrderRequest(
            symbol=trading.symbol,
            side=side,
            order_type="limit",
            amount=amount,
            price=price,
        )
        live_auth = self.service.settings.trading_mode != "live" or self.operator_is_valid()
        if not live_auth:
            raise PermissionError("Live operator session expired before order submission")
        order = await asyncio.to_thread(self.order_engine.execute, request, live_auth)
        self._last_action = f"{side} order {order['client_order_id']} ({order['status']})"
        self._log_tick(trading.symbol, candles[-1][4], signal, self._last_action)

    async def on_stop(self) -> None:
        self._last_action = "stopped"

    def status(self) -> dict[str, Any]:
        return {
            "name": "KronosStrategy",
            "running": self._last_action not in {"stopped", "idle"},
            "symbol": self.config_manager.current().trading.symbol,
            "timeframe": self.config_manager.current().trading.timeframe,
            "last_tick": self._last_tick,
            "last_error": self._last_error,
            "last_action": self._last_action,
            "latest_signal": self._latest_signal,
            "latest_forecast": self._latest_forecast,
            "kronos": self.kronos.status,
        }

    def _log_tick(self, symbol: str, last_close: float, signal: dict[str, Any], action: str) -> None:
        self.events.publish("strategy_tick", {
            "symbol": symbol,
            "last_close": float(last_close),
            "predicted_close": signal.get("predicted_close"),
            "expected_return": signal.get("expected_return"),
            "confidence": signal.get("confidence"),
            "signal": signal.get("signal"),
            "position": str(self.positions.get_position(symbol) or {}),
            "action": action,
        })
