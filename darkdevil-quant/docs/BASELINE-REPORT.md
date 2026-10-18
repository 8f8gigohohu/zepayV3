# DarkDevil Quant — Baseline Report (M1)

**Repo:** https://github.com/8f8gigohohu/darkdevil-quant
**Commit:** f7ffc8a
**Date:** 2026-10-17
**State:** Working, tested, safety-first (fail-closed)

## 1) What exists (verified from codebase)

### Backend (FastAPI, Python 3.11+)
- Core app: `app/main.py` with lifespan, CORS, `/api/version`, router wiring.
- Config: `app/config.py` — env-driven (Pydantic Settings), dev defaults; production requires `DJQ_SECRET_KEY`. Binance public defaults to `data-api.binance.vision` (market-data-only), ZebPay base `https://sapi.zebpay.com`.
- DB: `app/db.py` — async SQLAlchemy (SQLite dev default, Postgres via `asyncpg` optional). Tables created at startup via `Base.metadata.create_all` (migrations deferred to M2 per SECURITY.md note).
- Models: `app/models.py` — `User` (role: admin/trader/viewer), `AuditLog` (append-only), `ExchangeCredential` (encrypted secrets, masked key, test result), `Setting` (key/value).
- Security: `app/security.py` — bcrypt passwords, JWT (HS256), Fernet-derived AES envelope for secrets (key from `DJQ_SECRET_KEY`), key masking. Production secret management flagged for upgrade.
- Audit: `app/audit.py` — append-only insert with field redaction.
- Auth: `app/auth/router.py`, `app/auth/deps.py` — register/login, first user becomes admin, RBAC (`require_role`), me/users.
- Exchanges: `app/exchanges/base.py` (Envelope with provenance, Capability/CapabilityStatus, intervals), `http.py` (typed errors), `binance.py` (public live-verified, signed account implemented docs-verified), `zebpay.py` (public live-verified, klines units clarified by live probing, private not implemented by policy), `registry.py` (honest capability notes).
- Routers: `app/routers/system.py` (health, `/api/system/exchanges` with caching/reachability), `markets.py` (provenance-wrapped tickers/klines/orderbook/trades, auth-required), `credentials.py` (encrypted save, masked keys, explicit test of private endpoints, honest failure reporting), `trading.py` (post-orders fails closed with audit; unreachable in M1).
- Risk: `app/risk/engine.py` — independent fail-closed: kill switch → live trading gate → adapter capability (place_order) → input checks → stale-data check (30s). Defaults to kill-switch active, global live trading off.
- Tests: `backend/tests/` — conftest sets temp DB + env, 16 passed/2 skipped. Covers auth, adapters (fixture-based parsing), risk engine. Live-network tests opt-in via `DJQ_NETWORK_TESTS=1`.

### Frontend (Next.js 15, React 19, TypeScript, Tailwind v4)
- Layout: `app/layout.tsx`, `app/globals.css` (dark terminal theme), `app/nav.tsx` (shows live-trading kill/switch state, M1 badge).
- Pages: `page.tsx` (dashboard with system health, exchange matrix, live BTCUSDT via backend envelope), `markets/page.tsx` (searchable live tickers for binance/zebpay, freshness/stale warnings), `login/page.tsx` (register/login, first user admin).
- API client: `lib/api.ts` — bearer token in localStorage (noted trade-off in SECURITY.md), wraps responses/errors, helpers for age/formatting.
- Config: `next.config.mjs` rewrites `/api/*` to upstream backend (supports `DJQ_API_UPSTREAM`).

### Ops & docs
- `scripts/doctor.py` — checks tools, dependencies, secrets hygiene, DB connectivity, exchange reachability; exits non-zero on hard failures.
- `docker-compose.yml` — postgres + redis + backend + frontend; DB/Redis internal-only (not published). Backend runs uvicorn; frontend uses Next start.
- `backend/Dockerfile`, `frontend/Dockerfile` — production images.
- `.env.example` — comprehensive placeholders; emphasizes generating `DJQ_SECRET_KEY`.
- `.gitignore` — excludes `.venv`, `node_modules`, `logs-*.log`, `.env`, `*.db`, `.egg-info`, `data/`.
- Docs: `ARCHITECTURE.md`, `docs/ACCEPTANCE-M1.md`, `docs/SECURITY.md`, `README.md`.

## 2) What works (verified)
- Backend tests: **16 passed, 2 skipped** (opt-in). Exit code 0 with `pipefail`.
- Frontend: **Next.js production build passes** (typecheck included).
- Doctor: reports **0 failures** in the verified environment; checks exchange reachability and surfaces geo-restriction honestly.
- Live data verified end-to-end: Binance public tickers/market data via `data-api.binance.vision`; ZebPay public tickers/orderbook/trades/klines via `sapi.zebpay.com` (klines epoch-seconds confirmed by live probing).
- Auth/RBAC: registration, login, first user admin, role checks, audit on auth events.
- Security: secrets encrypted at rest; masked keys; no secrets in responses; audit redaction; append-only audit.
- Risk: three independent fail-closed layers for orders (config, kill switch, adapter capability `place_order` not verified). Order submission always rejected in M1 and audited.
- API contract: every market/response is wrapped in Envelope with provenance (exchange, endpoint, source_url, verified, ts_ms, upstream_ts_ms, stale_after_ms, age_ms). UI renders freshness and states.
- Honest capability matrix in API/UI (shows `GEO-RESTRICTED` where applicable, not implemented states explicit).

## 3) What’s missing / partially implemented (per upgrade spec)
Missing by design/planned: WebSocket streaming (M2), private trading/placement (M2–M3), balances/order history (M2), Hummingbot integration (M3), Kronos (M4), wallet connections (M5), full automated trading + reconciliation (M6). Paper trading (M5 stage) not yet implemented. Learning pipeline not implemented. Backtesting framework not present. Alembic migrations (table creation at startup). Cookie-based sessions + CSRF (localStorage token is noted trade-off).

## 4) Technical debt / compatibility risks
- Token storage: JWT in `localStorage` (XSS-sensitive). SECURITY.md marks moving to HttpOnly cookies + CSRF in M2.
- Migrations: `Base.metadata.create_all` at startup — Alembic needed for production schema evolution.
- Rate limits: no explicit per-endpoint/user rate limiting in M1 (basic upstream handling exists). Should add for auth/creds/trading.
- Background jobs: none; polling intervals hardcoded in UI (15s/20s) — acceptable for M1 but configurable later.
- Wallets/exchanges expansion: adding new exchanges requires implementing full adapter contract with honest capability states (policy already enforced).
- Kronos: model weights/artifacts can be large; Windows 11 path handling needed; optional remote inference to avoid local GPU/space constraints.

## 5) Files changed/added baseline (clean tree)
Working tree clean at commit f7ffc8a. 46 tracked files as pushed.

## Conclusion
Baseline is production-grade for M1 (honest, fail-closed, well-tested). The upgrade should **preserve** this safety posture and existing architecture, extend incrementally (M0→M7) as specified, and never weaken safety gates to make demos pass.
