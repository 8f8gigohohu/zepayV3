from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .auth import SessionManager
from .config import Settings, get_settings
from .exchange import ExchangeGateway, ExchangeGatewayError, ExchangeUnavailable, SubmissionUncertain
from .kronos import KronosAdapter, KronosUnavailable
from .risk import RiskViolation
from .schemas import LimitOrderRequest, LoginRequest
from .storage import Store
from .trading import LiveTradingDisabled, OperatorAuthenticationRequired, TradingService
from .utils import normalize_symbol

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app(
    settings: Settings | None = None,
    gateway: ExchangeGateway | None = None,
    store: Store | None = None,
    kronos: KronosAdapter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    store = store or Store(settings.database_path, settings.paper_starting_inr)
    gateway = gateway or ExchangeGateway(settings)
    kronos = kronos or KronosAdapter(settings)
    service = TradingService(settings, gateway, store, kronos)
    sessions = SessionManager()

    app = FastAPI(
        title="Zepay Trading Desk",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.store = store
    app.state.gateway = gateway
    app.state.kronos = kronos
    app.state.service = service
    app.state.sessions = sessions

    @app.exception_handler(RiskViolation)
    async def risk_error_handler(_request: Request, exc: RiskViolation) -> Response:
        return Response(
            content=_json_error(str(exc), "risk_check_failed"),
            status_code=422,
            media_type="application/json",
        )

    @app.exception_handler(LiveTradingDisabled)
    async def live_locked_handler(_request: Request, exc: LiveTradingDisabled) -> Response:
        return Response(content=_json_error(str(exc), "live_trading_locked"), status_code=423, media_type="application/json")

    @app.exception_handler(OperatorAuthenticationRequired)
    async def operator_auth_handler(_request: Request, exc: OperatorAuthenticationRequired) -> Response:
        return Response(content=_json_error(str(exc), "operator_login_required"), status_code=401, media_type="application/json")

    @app.exception_handler(ExchangeUnavailable)
    async def exchange_unavailable_handler(_request: Request, exc: ExchangeUnavailable) -> Response:
        return Response(content=_json_error(str(exc), "exchange_unavailable"), status_code=503, media_type="application/json")

    @app.exception_handler(SubmissionUncertain)
    async def uncertain_submission_handler(_request: Request, exc: SubmissionUncertain) -> Response:
        return Response(content=_json_error(str(exc), "submission_unknown"), status_code=409, media_type="application/json")

    @app.exception_handler(KronosUnavailable)
    async def kronos_unavailable_handler(_request: Request, exc: KronosUnavailable) -> Response:
        return Response(content=_json_error(str(exc), "kronos_unavailable"), status_code=503, media_type="application/json")

    @app.exception_handler(ValueError)
    async def value_error_handler(_request: Request, exc: ValueError) -> Response:
        return Response(content=_json_error(str(exc), "invalid_request"), status_code=422, media_type="application/json")

    def is_operator_authenticated(request: Request) -> bool:
        return sessions.is_valid(request.cookies.get("operator_session"))

    def require_operator(request: Request) -> bool:
        if settings.trading_mode == "live" and not is_operator_authenticated(request):
            raise OperatorAuthenticationRequired("Sign in to the trading desk to access live account data")
        return is_operator_authenticated(request)

    @app.get("/api/health")
    def health(request: Request) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "zepay-trading-desk",
            "mode": settings.trading_mode,
            "live_ready": settings.live_ready,
            "operator_authenticated": is_operator_authenticated(request),
            "operator_login_required": settings.requires_operator_login,
            "credentials_configured": settings.has_api_credentials,
            "allowed_symbols": sorted(settings.allowed_symbols),
            "risk": settings.public_view()["risk"],
            "market_data": "ZebPay Spot when reachable; clearly-labelled simulated feed in paper mode if offline",
            "trading_adapter": "CCXT ZebPay Spot",
            "kronos": kronos.status,
            "hummingbot_extension": "integrations/hummingbot/connector/exchange/zebpay",
        }

    @app.get("/api/config")
    def public_config() -> dict[str, Any]:
        return settings.public_view()

    @app.get("/api/market")
    def market(symbol: str = "BTC/INR") -> dict[str, Any]:
        return service.get_market(symbol)

    @app.get("/api/candles")
    def candles(
        symbol: str = "BTC/INR",
        timeframe: str = "5m",
        limit: int = Query(default=120, ge=20, le=300),
    ) -> dict[str, Any]:
        return {
            "symbol": normalize_symbol(symbol),
            "timeframe": timeframe,
            "candles": service.get_candles(symbol, timeframe, limit),
        }

    @app.get("/api/portfolio")
    def portfolio(request: Request) -> dict[str, Any]:
        require_operator(request)
        return service.portfolio()

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
        authenticated = require_operator(request)
        return service.place_order(payload, operator_authenticated=authenticated)

    @app.delete("/api/orders/{client_order_id}")
    def cancel_order(client_order_id: str, request: Request, symbol: str | None = None) -> dict[str, Any]:
        require_operator(request)
        return service.cancel_order(client_order_id, symbol)

    @app.get("/api/strategy/signals")
    def strategy_signals(symbol: str = "BTC/INR", timeframe: str = "5m") -> dict[str, Any]:
        return service.signals(symbol, timeframe)

    @app.get("/api/forecast")
    def forecast(symbol: str = "BTC/INR", timeframe: str = "5m") -> dict[str, Any]:
        return service.forecast(symbol, timeframe)

    @app.post("/api/auth/login")
    def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
        if settings.trading_mode != "live":
            raise HTTPException(status_code=409, detail="The desk is in paper mode; live sign-in is not active")
        if not settings.live_ready:
            raise LiveTradingDisabled(
                "Live trading is locked until server-side keys, operator password, live arming, and secure cookies are configured"
            )
        remote_key = request.client.host if request.client else "unknown"
        token = sessions.login(remote_key, payload.password, settings.app_password)
        if token is None:
            raise HTTPException(status_code=401, detail="Incorrect password or login rate limit reached")
        response.set_cookie(
            key="operator_session",
            value=token,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            max_age=sessions.lifetime_seconds,
            path="/api",
        )
        return {"authenticated": True, "expires_in_seconds": sessions.lifetime_seconds}

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response) -> dict[str, bool]:
        sessions.revoke(request.cookies.get("operator_session"))
        response.delete_cookie("operator_session", path="/api", httponly=True, secure=settings.secure_cookie, samesite="strict")
        return {"authenticated": False}

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


def _json_error(message: str, code: str) -> str:
    import json
    return json.dumps({"error": message, "code": code}, ensure_ascii=False)


app = create_app()
