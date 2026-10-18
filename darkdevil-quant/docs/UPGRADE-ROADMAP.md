# DarkDevil Quant — Upgrade Roadmap (M0–M7)

**Source of truth:** Existing repo (https://github.com/8f8gigohohu/darkdevil-quant), commit f7ffc8a. Preserve working code and existing safety controls.

## M0 — Baseline & audit (done)
**Goal:** Inspect repo, establish baseline, record truth.

**Done:**
- Inspected backend/frontend/docs/config/tests/Docker.
- Ran backend tests (16 passed/2 skipped) and frontend build (green). Doctor passes.
- Created `docs/BASELINE-REPORT.md`.

**Acceptance:** baseline documented, tests/builds green. ✅

**Rollback:** N/A.

## M1 — Professional frontend (highest priority)
**Goal:** Upgrade UI to a coherent, responsive, accessible trading terminal while connecting to real backend data. Preserve provenance/freshness display.

**File-level changes (proposed):**
- `frontend/app/layout.tsx`, `frontend/app/nav.tsx` — improve sidebar/collapsible nav, status badges (live trading, environment, stale), accessibility.
- `frontend/app/page.tsx` — dashboard hierarchy: exchange/market, last price/24h, order book/trades preview when available, open orders/positions placeholders (honest “not implemented” when absent), risk/health, connection status, data freshness.
- `frontend/app/markets/page.tsx` — candlestick preview + intervals (REST now, WS later), better table, symbol search, clear stale warnings.
- New components under `frontend/components/` (reusable): `StatusBadge`, `DataFreshness`, `CapabilityMatrix`, `KlineChart` (lightweight, no fabrication), `EmptyState`, `ErrorState`, `ConfirmDialog`, `LoadingSkeleton`.
- `frontend/app/exchanges/page.tsx` (new) — Exchange Connections UI showing per-exchange capability matrix, stored credential masked, test result with timestamp/detail, connect/test/disconnect flows (honest states).
- `frontend/app/wallets/page.tsx` (new) — Wallets center scaffold: clearly separated from exchange accounts, states NOT_IMPLEMENTED until Phantom path is verified (M5). Don’t mix balances.
- `frontend/lib/api.ts` — add typed helpers for connections/status, better error formatting, token helpers; keep localStorage note until M2 cookie move.

**Acceptance tests:**
- Production build passes, typecheck clean.
- Dashboard/Markets render with real backend data; show provenance + freshness + age.
- No fabricated prices/balances when API fails; shows honest errors/states.
- Responsive (desktop/tablet/mobile) basic checks; keyboard nav works for key elements.
- Exchange Connections page shows honest states (no “connected” inferred from stored key alone).

**Verification:** run frontend build, manual smoke via dev server, check API responses include Envelope fields.

**Rollback:** revert frontend changes to last known good.

## M2 — Secure connections, sessions, audit hardening
**Goal:** Harden exchange credential workflows, account-read verification UX, session security groundwork, audit/logging polish, migrations.

**Proposed changes:**
- Backend: add Alembic (`backend/alembic/`) with initial migration matching current models (replace `create_all` over time). Keep startup fallback during transition? Or switch after migration exists.
- Backend: `app/auth/*` — move toward HttpOnly cookie sessions + CSRF (keep Bearer compatible during transition? Or document). SECURITY.md already flags this.
- Backend: `app/routers/credentials.py` — improve test UX (clear reason on 403/451), last test timestamp formatting, permission guidance shown to UI.
- Backend: rate limiting (e.g., slowapi or in-middleware) on `/api/auth/*`, `/api/connections/*`, `/api/trading/*` (defensive, no order placement in M1).
- Frontend: wire Exchanges page to real endpoints (`GET /api/connections/status`, `POST /api/connections`, `POST /api/connections/{ex}/test`, `DELETE /api/connections/{ex}`).
- Docs: update SECURITY.md with rotation guidance and cookie/CSRF plan details.

**Acceptance:** migrations run (dev), connections flow works end-to-end with honest states, rate limits don’t break normal UX, audit events present.

**Rollback:** revert auth/migrations; keep existing create_all behavior if needed.

## M3 — Streaming, analytics, market UX
**Goal:** WS streaming where official support exists; fallback to REST. Add candlesticks, order book depth view, recent trades. Stale-data detection UX.

**Proposed changes:**
- Backend: WS proxy/service for Binance market data if feasible (respect official endpoints), with reconnect/backpressure, heartbeats, message validation. ZebPay: public spot WS unsupported per current knowledge — label explicitly, never fabricate.
- Frontend: `components/KlineChart.tsx` (e.g., lightweight candlestick), order book panel, trades panel with timestamps (upstream + received). Show stream type (WS/REST), gaps/staleness.
- Backend: `app/routers/markets.py` — optional streaming endpoints or WS upgrade; keep REST as fallback and labeled.
- Risk/UX: surface stale warnings in UI when age>stale_after_ms.

**Acceptance:** streaming reconnects on drop (bounded backoff), no silent data substitution, UI clearly labels REST vs WS, gaps detected.

## M4 — AI Trading Lab + Kronos
**Goal:** Add AI Lab UI + safe model adapter boundary. Kronos integration only if compatible after inspection; never bypass risk controls.

**Proposed changes:**
- Frontend: `frontend/app/ai-lab/page.tsx` — analysis UI, structured decision display (action/confidence/reason_codes/evidence/risk_checks/strategy_version/model_version/created_at). Confidence labeled as model-reported, not guaranteed.
- Backend: `app/ai/` package — `schemas.py` (validated decision schema), `adapter_base.py`, `noop_adapter.py` (safe default), `kronos_adapter.py` (optional). If model artifacts missing/unloadable, show disabled state.
- Model config: env vars for model path/checkpoint, device, timeout, optional remote inference endpoint (no secrets sent to remote). Document Windows 11 paths.
- Safety: all AI ideas must pass deterministic validation/risk checks before order consideration; AI never calls order endpoints directly. Timeouts/retries bounded.

**Acceptance:** schema validation enforced, disabled state works if model unavailable, no live orders from AI path, baseline comparison scaffolded.

## M5 — Backtesting, paper trading, learning pipeline, wallets (Phantom)
**Goal:** Deterministic backtesting, labeled paper exchange, versioned learning records, controlled promotion (human approval). Wallets: Phantom support only where verified, clearly separated from exchange accounts.

**Proposed changes:**
- Backend: `app/backtest/` — historical candles, fees/slippage, no look-ahead, train/val/holdout, walk-forward, metrics (drawdown, etc.). Reproducible configs.
- Backend: `app/paper/` — deterministic simulated exchange labeled as SIMULATED; tracks virtual balances/positions/fills/PnL; models assumptions; never describes as real.
- Backend: `app/learning/` — `learning_records` model + cycle (observe→decide→evaluate→record→analyze→propose→backtest→validate→compare→approve→promote). Requires minimum samples, OOS, walk-forward, cost stress, baseline comparison; no auto-promotion on single trade.
- Frontend: `app/backtesting/`, `app/paper-trading/`, `app/strategies/`, `app/learning/` pages with clear mode labels.
- Wallets: `app/wallets/` + `frontend/app/wallets/page.tsx`. Phantom integration only after verifying SDK/provider for chosen networks; never request seed/private key; never custody; transaction signing requires explicit user approval; never mix exchange vs wallet balances; wallet never authenticates exchange API.

**Acceptance:** backtests reproducible, paper fills labeled simulated, learning records versioned, promotion requires human approval, wallet path read-only-safe until tx path verified.

## M6 — Hummingbot integration readiness + live execution controls
**Goal:** Integrate only verified Hummingbot connector capabilities. Keep live execution DISABLED until all safety acceptance tests pass.

**Proposed changes:**
- Backend: `app/hummingbot/` boundary isolated from core risk; connector capability discovery; market/rule validation; precision/min notional checks; rate limiting; reconciliation hooks. Do not assume ZebPay connector exists — verify first.
- Risk: strengthen order lifecycle (idempotency DB-backed, reconciliation on timeout/restart, pre-trade checks, stale-data rejection, kill switch, audit). Maintain fail-closed posture.
- Frontend: `app/orders/`, `app/trade-history/`, `app/portfolio/`, `app/risk-management/`, `app/activity/` with honest states.

**Acceptance:** all safety gates tested, no live orders possible unless explicitly enabled and all criteria met; Hummingbot integration labeled honest (implemented vs not).

## M7 — Hardening, deployment, final acceptance
**Goal:** Polish, Windows 11 setup, Docker/compose validation, health/readiness, backups, dependency updates guidance, final feature matrix, changelog.

**Deliverables:** updated README (Windows 11), docs/FEATURE-CAPABILITY-MATRIX.md, docs/SECURITY.md updates, docker-compose validation notes, migration docs, final acceptance report. All tests pass.

**Acceptance:** reproducible setup, all milestones acceptance criteria satisfied, truthful capability reporting.

## Dependencies & compatibility risks (notable)
- Kronos: model weights can be large; avoid requiring model load to view dashboard/markets. Support optional remote inference. Document Windows paths and hardware constraints.
- ZebPay private: not implemented pending doc clarification — policy enforced.
- Binance geo-block (451): private endpoints remain docs-verified only; test from unrestricted network before claiming live-verified for private paths.
- Security: localStorage token -> cookies+CSRF (M2); migrations (M2); rate limiting (M2).

## Rollback strategy (global)
Each milestone: commit in small logical chunks, run tests/builds after changes, tag before risky changes if needed. Revert to previous commit on failure; preserve DB volumes in compose. Never remove safety gates.
