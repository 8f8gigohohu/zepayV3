from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import SessionManager
from .config import LIVE_ORDER_ROUTING_BLOCK_REASON, LIVE_ORDER_ROUTING_SUPPORTED, Settings, get_settings
from .private_settings import BootstrapTokenStore, PrivateSettingsStore, private_settings_path
from .engine.order_engine import OrderEngine
from .engine.order_tracker import InFlightOrder, OrderTracker
from .engine.risk_engine import RiskEngine
from .events import LiveEventHub
from .exchange import ExchangeGateway, ExchangeUnavailable
from .journal import JournalRepository
from .kronos import KronosAdapter, KronosUnavailable
from .risk import RiskViolation
from .runtime_config import RuntimeConfig, RuntimeConfigManager
from .schemas import (
    BootstrapRequest,
    ConnectionTestRequest,
    CredentialUpdateRequest,
    LimitOrderRequest,
    LiveArmRequest,
    LoginRequest,
    PasswordChangeRequest,
    StrategyStartRequest,
)
from .storage import Store
from .strategy.manager import StrategyManager
from .trading import LiveTradingDisabled, OperatorAuthenticationRequired, TradingService
from .utils import normalize_symbol

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
logger = logging.getLogger("zepay.api")


def create_app(
    settings: Settings | None = None,
    gateway: ExchangeGateway | None = None,
    store: Store | None = None,
    kronos: KronosAdapter | None = None,
    runtime_config: RuntimeConfigManager | None = None,
    journal: JournalRepository | None = None,
    events: LiveEventHub | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    private_store = PrivateSettingsStore(private_settings_path(settings.database_path))
    bootstrap_tokens = BootstrapTokenStore(settings.database_path.parent / "initial-setup.token")
    if settings.operator_auth_ready:
        bootstrap_tokens.consume()
    else:
        bootstrap_tokens.ensure()
    settings_lock = threading.RLock()
    if runtime_config is None:
        runtime_path = os.getenv("RUNTIME_CONFIG_PATH", "").strip()
        if runtime_path:
            target_path = Path(runtime_path).expanduser()
            runtime_config = RuntimeConfigManager(target_path)
            if not target_path.exists():
                runtime_config.update(RuntimeConfigManager().current())
        else:
            runtime_config = RuntimeConfigManager()
    initial_runtime = runtime_config.current()
    store = store or Store(settings.database_path, settings.paper_starting_inr)
    journal = journal or JournalRepository(settings.database_path)
    gateway = gateway or ExchangeGateway(
        settings,
        rate_limit_ms=initial_runtime.exchange.rate_limit_ms,
        max_retries=initial_runtime.exchange.max_retries,
    )
    kronos = kronos or KronosAdapter(settings, initial_runtime.kronos)
    if hasattr(kronos, "apply_config"):
        kronos.apply_config(initial_runtime.kronos)
    events = events or LiveEventHub()
    risk_engine = RiskEngine(initial_runtime.risk, journal, mode=settings.trading_mode)
    service = TradingService(
        settings,
        gateway,
        store,
        kronos,
        journal=journal,
        events=events,
        strategy_risk=risk_engine,
    )
    sessions = SessionManager(secret=settings.jwt_secret if len(settings.jwt_secret) >= 32 else None)

    def tracker_callback(event_name: str, previous: InFlightOrder, current: InFlightOrder) -> None:
        events.publish(event_name, {"previous": previous.to_dict(), "order": current.to_dict()})

    tracker = OrderTracker(callback=tracker_callback)
    order_engine = OrderEngine(service, tracker)

    def operator_is_valid(token: str | None) -> bool:
        return settings.trading_mode != "live" or sessions.is_valid(token)

    strategy_manager = StrategyManager(
        service=service,
        order_engine=order_engine,
        positions=service.positions,
        risk=risk_engine,
        kronos=kronos,
        config=runtime_config,
        events=events,
        operator_is_valid=operator_is_valid,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        events.bind_loop()
        runtime = runtime_config.current()
        if runtime.trading.enabled:
            # A process restart is never an instruction to resume autonomous execution.
            runtime.trading.enabled = False
            runtime_config.update(runtime)
        try:
            await order_engine.reconcile()
        except Exception as exc:
            logger.warning("Initial order reconciliation did not complete: %s", str(exc)[:240])
        await strategy_manager.start_reconciliation()
        market_task = asyncio.create_task(_market_event_loop(), name="market-event-broadcaster")
        try:
            yield
        finally:
            market_task.cancel()
            try:
                await market_task
            except asyncio.CancelledError:
                pass
            await strategy_manager.shutdown()
            if journal is not None:
                journal.close()

    app = FastAPI(
        title="ZebPay-Kronos Trading Terminal",
        version="0.2.0",
        description="Paper-first ZebPay Spot terminal with guarded exchange access, persistent execution accounting, and optional Kronos forecasts.",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Requested-With"],
    )

    app.state.settings = settings
    app.state.store = store
    app.state.gateway = gateway
    app.state.journal = journal
    app.state.kronos = kronos
    app.state.service = service
    app.state.sessions = sessions
    app.state.events = events
    app.state.runtime_config = runtime_config
    app.state.risk_engine = risk_engine
    app.state.order_tracker = tracker
    app.state.order_engine = order_engine
    app.state.strategy_manager = strategy_manager
    app.state.private_settings_store = private_store
    app.state.bootstrap_token_store = bootstrap_tokens

    def apply_settings(next_settings: Settings, *, rotate_sessions: bool = False) -> None:
        nonlocal settings, sessions
        with settings_lock:
            settings = next_settings
            service.settings = next_settings
            service.risk.settings = next_settings
            kronos.settings = next_settings
            if hasattr(gateway, "update_settings"):
                gateway.update_settings(next_settings)
            else:
                gateway.settings = next_settings
            if rotate_sessions:
                sessions = SessionManager(secret=next_settings.jwt_secret)
            app.state.settings = next_settings
            app.state.sessions = sessions

    def ensure_same_origin(request: Request, *, require_https: bool = False) -> Any:
        origin = request.headers.get("origin", "")
        host = request.headers.get("host", "")
        parsed = urlsplit(origin)
        if not origin or not host or parsed.netloc.casefold() != host.casefold():
            raise HTTPException(status_code=403, detail="A same-origin browser request is required")
        if parsed.scheme not in {"https", "http"}:
            raise HTTPException(status_code=403, detail="Unsupported request origin")
        local_origin = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if require_https and parsed.scheme != "https" and not local_origin:
            raise HTTPException(status_code=400, detail="Complete setup over HTTPS")
        return parsed

    def require_settings_operator(request: Request) -> str:
        if not settings.operator_auth_ready:
            raise LiveTradingDisabled("Complete secure operator setup before changing account settings")
        token = request_token(request)
        if not sessions.is_valid(token):
            raise OperatorAuthenticationRequired("Sign in before changing exchange or security settings")
        return token

    def set_operator_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            key="operator_session",
            value=token,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            max_age=sessions.lifetime_seconds,
            path="/api",
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Pydantic errors can otherwise echo the submitted request value, which
        # may contain an API secret or operator password.
        safe_errors = [
            {key: value for key, value in error.items() if key not in {"input", "ctx"}}
            for error in exc.errors()
        ]
        return JSONResponse({"detail": safe_errors}, status_code=422)

    @app.exception_handler(RiskViolation)
    async def risk_error_handler(_request: Request, exc: RiskViolation) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "risk_check_failed"}, status_code=422)

    @app.exception_handler(LiveTradingDisabled)
    async def live_locked_handler(_request: Request, exc: LiveTradingDisabled) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "live_trading_locked"}, status_code=423)

    @app.exception_handler(OperatorAuthenticationRequired)
    async def operator_auth_handler(_request: Request, exc: OperatorAuthenticationRequired) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "operator_login_required"}, status_code=401)

    @app.exception_handler(ExchangeUnavailable)
    async def exchange_unavailable_handler(_request: Request, exc: ExchangeUnavailable) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "exchange_unavailable"}, status_code=503)

    @app.exception_handler(KronosUnavailable)
    async def kronos_unavailable_handler(_request: Request, exc: KronosUnavailable) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "kronos_unavailable"}, status_code=503)

    @app.exception_handler(PermissionError)
    async def permission_error_handler(_request: Request, exc: PermissionError) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "permission_denied"}, status_code=403)

    @app.exception_handler(RuntimeError)
    async def conflict_error_handler(_request: Request, exc: RuntimeError) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "operation_conflict"}, status_code=409)

    @app.exception_handler(ValueError)
    async def value_error_handler(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse({"error": str(exc), "code": "invalid_request"}, status_code=422)

    def request_token(request: Request) -> str | None:
        return request.cookies.get("operator_session")

    def is_operator_authenticated(request: Request) -> bool:
        return sessions.is_valid(request_token(request))

    def require_operator(request: Request) -> str | None:
        token = request_token(request)
        if settings.requires_operator_login and not sessions.is_valid(token):
            raise OperatorAuthenticationRequired("Sign in to the trading desk to access private account and strategy controls")
        return token

    def ensure_runtime_guardrails(config: RuntimeConfig) -> None:
        if config.trading.symbol not in settings.allowed_symbols:
            raise RiskViolation("The runtime strategy symbol is not in the server-side market allowlist")
        if config.trading.max_open_orders > settings.max_open_orders:
            raise RiskViolation("Runtime max_open_orders cannot exceed the server-side cap")
        risk = config.risk
        upper_limits = (
            ("max_position_base", risk.max_position_base, settings.max_position_base),
            ("max_daily_loss_quote", risk.max_daily_loss_quote, settings.max_daily_loss_quote),
            ("max_order_notional_quote", risk.max_order_notional_quote, settings.max_order_notional),
            ("max_daily_notional_quote", risk.max_daily_notional_quote, settings.max_daily_notional),
            ("max_daily_trades", risk.max_daily_trades, settings.max_daily_trades),
        )
        for name, configured, server_limit in upper_limits:
            if float(configured) > float(server_limit):
                raise RiskViolation(f"Runtime {name} cannot exceed the server-side guardrail")
        if risk.cooldown_after_loss_sec < settings.cooldown_after_loss_sec:
            raise RiskViolation("Runtime loss cooldown cannot be shorter than the server-side guardrail")
        if risk.circuit_breaker_pct > float(settings.circuit_breaker_pct):
            raise RiskViolation("Runtime circuit-breaker drawdown cannot be looser than the server-side guardrail")
        if config.database.url != initial_runtime.database.url:
            raise RiskViolation("Database location is fixed at startup; change DATABASE_PATH and restart instead")

    async def _market_event_loop() -> None:
        while True:
            try:
                if events.clients == 0:
                    await asyncio.sleep(2)
                    continue
                connected = 0
                failures: list[dict[str, str]] = []
                for symbol in sorted(settings.allowed_symbols):
                    try:
                        quote = await asyncio.to_thread(service.get_market, symbol)
                        connected += 1
                        events.publish("feed_status", {"connected": True, "symbol": symbol, "source": quote.get("source")})
                    except Exception as exc:
                        failures.append({"symbol": symbol, "error": str(exc)[:180]})
                        events.publish("feed_status", {"connected": False, "symbol": symbol, "source": "zebpay", "error": str(exc)[:180]})
                if not connected and failures:
                    events.publish("feed_error", {"source": "zebpay", "failures": failures})
                interval = max(3.0, runtime_config.current().ui.refresh_interval_ms / 1000)
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Market event broadcaster failed")
                await asyncio.sleep(5)

    @app.get("/api/health")
    def health(request: Request) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "zebpay-kronos-trading-terminal",
            "version": app.version,
            "mode": settings.trading_mode,
            "live_ready": False,
            "live_order_routing_supported": LIVE_ORDER_ROUTING_SUPPORTED,
            "live_order_routing_status": "not_implemented",
            "live_order_routing_detail": LIVE_ORDER_ROUTING_BLOCK_REASON,
            "operator_auth_ready": settings.operator_auth_ready,
            "operator_authenticated": is_operator_authenticated(request),
            "operator_login_required": settings.requires_operator_login,
            "credentials_configured": settings.has_api_credentials,
            "allowed_symbols": sorted(settings.allowed_symbols),
            "risk": settings.public_view()["risk"],
            "market_data": "ZebPay Spot REST only; unavailable data fails closed and is never replaced with sample prices",
            "trading_adapter": "CCXT ZebPay Spot (public/private reads only; live writes disabled)",
            "kronos": kronos.status,
            "strategy": strategy_manager.status(),
            "websocket": "/api/ws",
            "hummingbot_extension": "integrations/hummingbot/connector/exchange/zebpay",
        }

    @app.get("/api/status")
    def status(request: Request) -> dict[str, Any]:
        return {
            "health": health(request),
            "strategy": strategy_manager.status(),
            "risk": risk_engine.state(),
            "websocket_clients": events.clients,
        }

    @app.get("/api/config")
    def public_config(request: Request) -> dict[str, Any]:
        runtime = runtime_config.current()
        return {
            "server": settings.public_view(),
            "operator_authenticated": is_operator_authenticated(request),
            "setup": {
                "required": not settings.operator_auth_ready,
                "bootstrap_code_file": "data/initial-setup.token" if not settings.operator_auth_ready else None,
            },
            "runtime": runtime.model_dump(mode="json"),
        }

    @app.get("/api/markets")
    def markets() -> dict[str, Any]:
        result: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []
        for symbol in sorted(settings.allowed_symbols):
            try:
                result.append(service.get_market(symbol))
            except Exception as exc:
                failures.append({"symbol": symbol, "error": str(exc)[:180]})
        return {"markets": result, "failures": failures, "source": "zebpay"}

    @app.get("/api/market")
    def market(symbol: str = "BTC/INR") -> dict[str, Any]:
        return service.get_market(symbol)

    @app.get("/api/market/orderbook")
    def order_book(
        symbol: str = "BTC/INR",
        limit: int = Query(default=50, ge=5, le=200),
    ) -> dict[str, Any]:
        return service.order_book(symbol, limit)

    @app.get("/api/market/trades")
    def market_trades(
        symbol: str = "BTC/INR",
        limit: int = Query(default=50, ge=1, le=200),
    ) -> dict[str, Any]:
        return {"symbol": normalize_symbol(symbol), "trades": service.recent_market_trades(symbol, limit), "source": "zebpay"}

    @app.get("/api/candles")
    def candles(
        symbol: str = "BTC/INR",
        timeframe: str = "5m",
        limit: int = Query(default=120, ge=20, le=300),
    ) -> dict[str, Any]:
        normalized = normalize_symbol(symbol)
        return {
            "symbol": normalized,
            "timeframe": timeframe,
            "candles": service.get_candles(symbol, timeframe, limit),
            "source": "zebpay",
            "is_simulated": False,
        }

    @app.get("/api/portfolio")
    def portfolio(request: Request) -> dict[str, Any]:
        require_operator(request)
        result = service.portfolio()
        daily = journal.daily_stats(mode=settings.trading_mode)
        result["day_pnl_inr"] = str(daily["realized_pnl"])
        result["day_trades"] = daily["trades"]
        return result

    @app.get("/api/positions")
    def positions(request: Request) -> dict[str, Any]:
        require_operator(request)
        return {"positions": service.positions_snapshot(), "source": "desk_execution_journal"}

    @app.get("/api/orders")
    def orders(
        request: Request,
        symbol: str | None = None,
        limit: int = Query(default=50, ge=1, le=200),
    ) -> dict[str, Any]:
        require_operator(request)
        return {"orders": service.list_orders(symbol)[:limit]}

    @app.post("/api/orders")
    def place_order(payload: LimitOrderRequest, request: Request) -> dict[str, Any]:
        token = require_operator(request)
        authenticated = settings.trading_mode != "live" or sessions.is_valid(token)
        return order_engine.execute(payload, operator_authenticated=authenticated)

    @app.delete("/api/orders/{client_order_id}")
    def cancel_order(client_order_id: str, request: Request, symbol: str | None = None) -> dict[str, Any]:
        require_operator(request)
        return order_engine.cancel(client_order_id, symbol)

    @app.get("/api/journal/trades")
    def trade_journal(
        request: Request,
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        require_operator(request)
        trades, total = journal.list_trades(limit, offset, mode=settings.trading_mode)
        return {"trades": trades, "total": total, "limit": limit, "offset": offset}

    @app.get("/api/risk")
    def risk_status(request: Request) -> dict[str, Any]:
        require_operator(request)
        return {
            "mode": settings.trading_mode,
            "state": risk_engine.state(),
            "server_guardrails": settings.public_view()["risk"],
            "recent_events": journal.list_risk_events(20, mode=settings.trading_mode),
        }

    @app.post("/api/risk/resume")
    def resume_risk(request: Request) -> dict[str, Any]:
        require_operator(request)
        risk_engine.resume()
        result = risk_engine.state()
        events.publish("risk_status", result)
        return result

    @app.get("/api/strategy/signals")
    def strategy_signals(symbol: str = "BTC/INR", timeframe: str = "5m") -> dict[str, Any]:
        return service.signals(symbol, timeframe)

    @app.get("/api/strategy/forecast")
    @app.get("/api/forecast")
    async def forecast() -> dict[str, Any]:
        return await strategy_manager.forecast_preview()

    @app.get("/api/strategy/status")
    def strategy_status(request: Request) -> dict[str, Any]:
        require_operator(request)
        return strategy_manager.status()

    @app.get("/api/strategy/config")
    def get_strategy_config(request: Request) -> dict[str, Any]:
        require_operator(request)
        return runtime_config.current().model_dump(mode="json")

    @app.put("/api/strategy/config")
    def update_strategy_config(config: RuntimeConfig, request: Request) -> dict[str, Any]:
        require_operator(request)
        if strategy_manager.is_running:
            raise HTTPException(status_code=409, detail="Stop the autonomous strategy before changing its configuration")
        ensure_runtime_guardrails(config)
        config.trading.enabled = False
        saved = runtime_config.update(config)
        risk_engine.update_config(saved.risk)
        kronos.apply_config(saved.kronos)
        events.publish("config_update", saved.model_dump(mode="json"))
        return saved.model_dump(mode="json")

    @app.post("/api/strategy/start")
    async def start_strategy(_payload: StrategyStartRequest, request: Request) -> dict[str, Any]:
        token = require_operator(request)
        ensure_runtime_guardrails(runtime_config.current())
        return await strategy_manager.start(token)

    @app.post("/api/strategy/stop")
    async def stop_strategy(request: Request) -> dict[str, Any]:
        require_operator(request)
        return await strategy_manager.stop("Stopped by operator")

    @app.post("/api/strategy/emergency-stop")
    async def emergency_stop(request: Request) -> dict[str, Any]:
        require_operator(request)
        return await strategy_manager.emergency_stop()

    @app.post("/api/auth/bootstrap")
    def bootstrap_operator(payload: BootstrapRequest, request: Request, response: Response) -> dict[str, Any]:
        if settings.operator_auth_ready:
            raise HTTPException(status_code=409, detail="Operator setup is already complete; sign in to manage settings")
        origin = ensure_same_origin(request, require_https=True)
        if not bootstrap_tokens.verify(payload.setup_token.get_secret_value()):
            raise HTTPException(status_code=401, detail="The one-time local setup code is invalid")

        api_key = payload.api_key.get_secret_value().strip()
        api_secret = payload.api_secret.get_secret_value().strip()
        app_password = payload.app_password.get_secret_value()
        password_confirmation = payload.password_confirmation.get_secret_value()
        if not api_key or not api_secret or len(api_key) > 512 or len(api_secret) > 512:
            raise HTTPException(status_code=422, detail="Enter a valid ZebPay API key and secret")
        if len(app_password) < 12 or len(app_password) > 512:
            raise HTTPException(status_code=422, detail="Choose an operator password of 12 to 512 characters")
        if not hmac.compare_digest(app_password, password_confirmation):
            raise HTTPException(status_code=422, detail="The operator password entries do not match")

        secure_origin = origin.scheme == "https" or origin.hostname in {"localhost", "127.0.0.1", "::1"}
        if not secure_origin:
            raise HTTPException(status_code=400, detail="Complete setup over HTTPS")
        next_settings = replace(
            settings,
            api_key=api_key,
            api_secret=api_secret,
            app_password=app_password,
            jwt_secret=secrets.token_urlsafe(48),
            secure_cookie=True,
            live_trading_enabled=False,
        )
        try:
            private_store.save_settings(next_settings)
        except OSError as exc:
            logger.error("Unable to persist private settings (%s)", exc.__class__.__name__)
            raise HTTPException(status_code=500, detail="Secure settings could not be saved on the server") from exc

        apply_settings(next_settings, rotate_sessions=True)
        bootstrap_tokens.consume()
        remote_key = request.client.host if request.client else "unknown"
        token = sessions.login(remote_key, app_password, next_settings.app_password)
        if token is None:
            raise HTTPException(status_code=500, detail="Operator setup completed, but sign-in must be retried")
        set_operator_cookie(response, token)
        events.publish("operator_status", {"authenticated": True})
        return {
            "authenticated": True,
            "server": next_settings.public_view(),
            "live_ready": next_settings.live_ready,
            "live_order_routing_supported": LIVE_ORDER_ROUTING_SUPPORTED,
        }

    @app.post("/api/auth/login")
    def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
        if not settings.operator_auth_ready:
            raise LiveTradingDisabled("Complete first-run operator setup before signing in")
        remote_key = request.client.host if request.client else "unknown"
        token = sessions.login(remote_key, payload.password.get_secret_value(), settings.app_password)
        if token is None:
            raise HTTPException(status_code=401, detail="Incorrect password or login rate limit reached")
        set_operator_cookie(response, token)
        events.publish("operator_status", {"authenticated": True})
        return {
            "authenticated": True,
            "expires_in_seconds": sessions.lifetime_seconds,
            "live_ready": settings.live_ready,
        }

    @app.get("/api/auth/session")
    def auth_session(request: Request) -> dict[str, Any]:
        return {
            "authenticated": is_operator_authenticated(request),
            "login_required": settings.requires_operator_login,
            "operator_auth_ready": settings.operator_auth_ready,
            "live_ready": settings.live_ready,
            "mode": settings.trading_mode,
        }

    @app.post("/api/settings/credentials")
    def update_credentials(payload: CredentialUpdateRequest, request: Request) -> dict[str, Any]:
        require_settings_operator(request)
        ensure_same_origin(request)
        if strategy_manager.is_running:
            raise HTTPException(status_code=409, detail="Stop the strategy before rotating exchange credentials")
        if store.open_order_count("live"):
            raise HTTPException(status_code=409, detail="Resolve app-tracked live open orders before rotating credentials")
        api_key = payload.api_key.get_secret_value().strip()
        api_secret = payload.api_secret.get_secret_value().strip()
        if not api_key or not api_secret or len(api_key) > 512 or len(api_secret) > 512:
            raise HTTPException(status_code=422, detail="Enter a valid ZebPay API key and secret")
        next_settings = replace(settings, api_key=api_key, api_secret=api_secret, live_trading_enabled=False)
        try:
            private_store.save_settings(next_settings)
        except OSError as exc:
            logger.error("Unable to persist private settings (%s)", exc.__class__.__name__)
            raise HTTPException(status_code=500, detail="Secure settings could not be saved on the server") from exc
        apply_settings(next_settings)
        events.publish("settings_update", next_settings.public_view())
        return {"saved": True, "server": next_settings.public_view()}

    @app.post("/api/settings/password")
    def change_operator_password(payload: PasswordChangeRequest, request: Request, response: Response) -> dict[str, Any]:
        require_settings_operator(request)
        ensure_same_origin(request, require_https=True)
        current_password = payload.current_password.get_secret_value()
        new_password = payload.new_password.get_secret_value()
        password_confirmation = payload.password_confirmation.get_secret_value()
        if not hmac.compare_digest(current_password, settings.app_password):
            raise HTTPException(status_code=401, detail="Current operator password is incorrect")
        if len(new_password) < 12 or len(new_password) > 512:
            raise HTTPException(status_code=422, detail="Choose an operator password of 12 to 512 characters")
        if not hmac.compare_digest(new_password, password_confirmation):
            raise HTTPException(status_code=422, detail="The new password entries do not match")
        next_settings = replace(settings, app_password=new_password, jwt_secret=secrets.token_urlsafe(48))
        try:
            private_store.save_settings(next_settings)
        except OSError as exc:
            logger.error("Unable to persist private settings (%s)", exc.__class__.__name__)
            raise HTTPException(status_code=500, detail="Secure settings could not be saved on the server") from exc
        apply_settings(next_settings, rotate_sessions=True)
        remote_key = request.client.host if request.client else "unknown"
        token = sessions.login(remote_key, new_password, next_settings.app_password)
        if token is None:
            raise HTTPException(status_code=500, detail="Password changed, but sign-in must be retried")
        set_operator_cookie(response, token)
        events.publish("operator_status", {"authenticated": True})
        return {"authenticated": True, "server": next_settings.public_view()}

    @app.post("/api/settings/test-connection")
    def test_exchange_connection(payload: ConnectionTestRequest, request: Request) -> dict[str, Any]:
        require_settings_operator(request)
        ensure_same_origin(request)
        symbol = normalize_symbol(payload.symbol)
        if symbol not in settings.allowed_symbols:
            raise HTTPException(status_code=422, detail="Choose a server-allowed ZebPay INR spot pair")
        return gateway.test_connection(symbol)

    @app.post("/api/settings/live-arm")
    def configure_live_arm(payload: LiveArmRequest, request: Request) -> dict[str, Any]:
        require_settings_operator(request)
        ensure_same_origin(request)
        if not payload.armed:
            next_settings = replace(settings, live_trading_enabled=False)
            apply_settings(next_settings)
            events.publish("settings_update", next_settings.public_view())
            return {"server": next_settings.public_view(), "live_ready": False, "connection_test": None}
        raise LiveTradingDisabled(LIVE_ORDER_ROUTING_BLOCK_REASON)

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response) -> dict[str, bool]:
        sessions.revoke(request.cookies.get("operator_session"))
        response.delete_cookie(
            "operator_session",
            path="/api",
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
        )
        events.publish("operator_status", {"authenticated": False})
        return {"authenticated": False}

    @app.websocket("/api/ws")
    async def websocket_events(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        host = websocket.headers.get("host", "")
        if origin:
            parsed_origin = urlsplit(origin)
            same_origin = parsed_origin.netloc == host
            configured_origin = origin.rstrip("/") in {item.rstrip("/") for item in settings.cors_origins}
            if not same_origin and not configured_origin:
                await websocket.close(code=4403, reason="WebSocket origin is not allowed")
                return
        token = websocket.cookies.get("operator_session")
        if settings.requires_operator_login and not sessions.is_valid(token):
            await websocket.close(code=4401, reason="Operator sign-in required")
            return
        await websocket.accept()
        queue = await events.subscribe()
        try:
            await websocket.send_json({"type": "connected", "timestamp": time.time(), "data": {
                "mode": settings.trading_mode,
                "strategy": strategy_manager.status(),
            }})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    if settings.requires_operator_login and not sessions.is_valid(token):
                        await websocket.close(code=4401, reason="Operator session expired")
                        break
                    await websocket.send_json({"type": "heartbeat", "timestamp": time.time(), "data": {}})
                    continue
                if settings.requires_operator_login and not sessions.is_valid(token):
                    await websocket.close(code=4401, reason="Operator session expired")
                    break
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            events.unsubscribe(queue)

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


app = create_app()
