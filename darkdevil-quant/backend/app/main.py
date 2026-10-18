import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth.router import router as auth_router
from .config import get_settings
from .db import Base, init_engine
from .routers import credentials, markets, system, trading


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    # Create tables at startup (M1). Migrations move to Alembic in M2.
    from .db import engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield
    finally:
        from .db import engine
        if engine is not None:
            await engine.dispose()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title=s.app_name, version="0.1.0", lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origin_list,
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def browser_security(request: Request, call_next):
        # Browser mutations authenticated by cookies must prove possession of the
        # same-origin CSRF nonce. Login/registration are exempt until a session exists.
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.cookies.get("djq_session"):
            cookie_nonce = request.cookies.get("djq_csrf", "")
            header_nonce = request.headers.get("x-csrf-token", "")
            if not cookie_nonce or not header_nonce or not hmac.compare_digest(cookie_nonce, header_nonce):
                return JSONResponse({"detail": "CSRF validation failed"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith(("/api/auth", "/api/connections")):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(RequestValidationError)
    async def redact_validation_inputs(_request: Request, exc: RequestValidationError):
        # FastAPI's default 422 body can echo `input`; credential/password request
        # bodies must never be reflected into a response or browser console.
        safe_errors = [
            {key: value for key, value in error.items() if key not in {"input", "ctx"}}
            for error in exc.errors()
        ]
        return JSONResponse({"detail": safe_errors}, status_code=422)

    app.include_router(auth_router)
    app.include_router(system.router)
    app.include_router(markets.router)
    app.include_router(credentials.router)
    app.include_router(trading.router)

    @app.get("/api/version")
    async def version():
        return {"app": s.app_name, "version": "0.1.0", "milestone": 1}
    return app


app = create_app()
