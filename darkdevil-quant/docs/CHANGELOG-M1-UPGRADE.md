# Changelog — Milestone 1 upgrade pass

Date: 2026-10-17 · Base commit: `f7ffc8a` · Scope: audit + professional frontend + secure
connection experience. No working M1 behaviour was removed and no safety gate was weakened.

## Added — documentation (deliverables from the upgrade brief)

| File | Why |
|---|---|
| `docs/BASELINE-REPORT.md` | Milestone 0: what exists, what works, what is missing, technical debt. |
| `docs/UPGRADE-ROADMAP.md` | M0–M7 plan with file-level changes, acceptance tests and rollback per milestone. |
| `docs/FEATURE-CAPABILITY-MATRIX.md` | Implemented / partial / missing / unsupported / verified per feature area. |
| `docs/CHANGELOG-M1-UPGRADE.md` | This file: every changed file and the reason. |

## Added — frontend components (`frontend/components/`)

| File | Why |
|---|---|
| `Shell.tsx` | Replaces the two-link header with a collapsible sidebar (grouped navigation), top bar with live system/environment/live-trading badges, account identity, sign-out, and a warning banner when live trading is enabled by configuration. |
| `StatusBadge.tsx` | One semantic badge (ok/warn/bad/muted) so state colours are consistent. |
| `DataFreshness.tsx` | Renders source URL, endpoint, age and STALE state for every data panel. |
| `CapabilityMatrix.tsx` | Renders the exchange capability states verbatim (no colour implies more than the API reports). |
| `States.tsx` | Loading skeleton, empty state, error state with recovery hint, and an honest development-status notice. |
| `ConfirmDialog.tsx` | Accessible confirmation (Escape/backdrop dismiss) for destructive/financial actions. |
| `PlannedPage.tsx` | Consistent honest page for capabilities that are not implemented yet. |
| `CandleChart.tsx` | Dependency-free SVG candlestick chart drawing only candles the exchange returned; renders an explicit "no candles" message instead of a fabricated series. |

## Added — pages (all 14 required sections now exist)

| Route | State |
|---|---|
| `/` | Rewritten dashboard: system/risk status strip, selected market with price/24h/spread, real order book, recent trades, exchange capability report, workspace status list, safety posture. |
| `/markets` | Rewritten: searchable ticker table, click-to-select, candlestick chart with 1m–1d interval switch, provenance/freshness, unsupported-interval error instead of a blank chart. |
| `/exchanges` | New: credential form, per-exchange lifecycle state, masked key, last test result/time, test/disconnect with confirmation, capability matrix, security guidance. |
| `/risk` | New: real gate states and limits from the backend, kill-switch state/source, admin-only activate/release behind a confirmation dialog. |
| `/system` | New: health, database, environment, version, live exchange reachability + full capability matrix. |
| `/settings` | New: account identity/role, sign-out, documented security controls and known gaps. |
| `/wallets`, `/ai-lab`, `/strategies`, `/backtesting`, `/paper-trading`, `/orders`, `/portfolio`, `/activity` | New: honest not-implemented pages stating milestone, blocker and planned scope — no simulated values anywhere. |
| `frontend/app/nav.tsx` | **Removed** — superseded by `Shell.tsx` (navigation moved into the sidebar). |
| `frontend/lib/sections.ts` | Single source of truth for navigation groups and each section's honest status. |
| `frontend/lib/api.ts` | Added `ApiError` (keeps HTTP status so 401 is distinguishable), `clearToken`, `fmtTime`, array-detail formatting, 204 handling. |
| `frontend/app/layout.tsx` | Wraps the app in the new shell; metadata updated. |

## Changed — backend

| File | Change | Why |
|---|---|---|
| `app/routers/credentials.py` | Added `_derive_state()` and the lifecycle states `NOT_CONFIGURED`, `CONFIGURED_UNTESTED`, `CONNECTED_READ_ONLY`, `VERIFIED_FOR_TRADING`, `ERROR`, `UNSUPPORTED`; `/status` now returns `state`, `state_detail`, per-capability statuses, `trading_state`, the full capability matrix and security guidance. | The API previously exposed raw fields (`connected: false`, `last_test_status`), leaving the UI to guess. State is now derived from evidence only: a stored key is never reported as a connection, and a successful account read is reported as read-only, never as trading-ready. |
| `app/routers/credentials.py` | **Bug fix:** persist `last_test_detail` and `last_test_at` on the credential. | The model had both columns but the code never wrote them, so the reason for a failed test and the test time were lost after the response — the UI had nothing to display. Detail is truncated to 400 chars so an upstream body cannot bloat the row, response or audit entry. |
| `app/routers/system.py` | New read-only `GET /api/system/risk` (auth required) returning gate states, configured limits and kill-switch state/source. | The Risk page must show the exact values the engine uses rather than a description of them. |

## Added — tests

| File | Coverage |
|---|---|
| `tests/test_connections.py` | Lifecycle states (`NOT_CONFIGURED` → `CONFIGURED_UNTESTED` → `UNSUPPORTED`/`ERROR`), auth required, saved keys are masked and never echoed (response body asserted free of key/secret), persisted failure detail, delete returns to `NOT_CONFIGURED`. |
| `tests/test_connection_states.py` | Synchronous mapping table for every documented state, including that no state can claim `VERIFIED_FOR_TRADING` while `place_order` is unimplemented. |

## Changed — tooling

| File | Change | Why |
|---|---|---|
| `scripts/doctor.py` | Imports the backend package from `backend/`, and reports missing dependencies with the exact install/run commands instead of raising `ModuleNotFoundError`. | Running it with a bare `python3` previously crashed with a traceback; now it fails cleanly with actionable output. |

## Verification for this pass

| Check | Result |
|---|---|
| `ruff check app tests` | **All checks passed!** (exit 0) |
| `pytest -q` | **28 passed, 2 skipped** (was 16 passed, 2 skipped) — exit 0, no warnings |
| `next build` | **Success**, 18 static routes including all 14 sections |
| Route smoke test (15 routes) | all `200` |
| Preview host-header probe | `200` (no 403 host rejection) |
| Live data through the frontend proxy | Binance BTCUSDT 81,625.12 USD (`verified_live`); ZebPay BTC-INR daily candles returned real rows |
| Connection lifecycle (live, fixture keys) | Binance → `ERROR` (upstream HTTP 451, geo-restriction noted); ZebPay → `UNSUPPORTED`; `last_test_at` populated (the ZebPay state changed in the follow-up pass below, once its private read was implemented) |
| Unauthenticated `/api/system/risk` | `401` |
| `scripts/doctor.py` | exit 1 with clean message (no backend deps) / exit 0 with venv python, 0 failures |

## Follow-up pass — ZebPay spot private API (2026-10-17)

Trigger: the previous pass reported ZebPay private endpoints as unverifiable. Re-checked against the
official sources, including the official Spot clients (which the earlier pass had not read).

| File | Change | Why |
|---|---|---|
| `app/exchanges/zebpay.py` | Implemented `encode_component()` / `build_query()` / `sign_query()`, `account()` (balances) and `open_orders()`, plus error translation for ZebPay's documented codes. | The signing canonicalisation *is* written down — in the official Node client, not in the prose guide. Header names and endpoint existence were confirmed by live probing. |
| `app/exchanges/zebpay.py` | `place_order()` and `cancel_order()` now raise `NotImplementedError` with the exact documented conflict; capabilities report `not_implemented`. | The docs and the official clients disagree on the order body (`amount` vs `quantity`, `quoteOrderAmount` vs `quoteOrderQty`, `stopLossPrice` vs `stopPrice`) and on cancel/detail paths. A guessed body is an uninsured financial action. |
| `app/routers/credentials.py` | New `GET /api/connections/{exchange}/account` (read-only snapshot; `501` unimplemented, `502` upstream failure). Test detail now records which timestamp unit the server accepted. | The implemented capability must be reachable by the product, not dead code, and the ambiguity reconciliation must be observable. |
| `app/exchanges/http.py` | **Bug fix:** only pass `params` to `httpx` when non-empty. | Passing `params={}` replaces the URL's query string, so the signed ZebPay `timestamp` never reached the server and every signed request failed with `400 "Missing timestamp."` Found by the live end-to-end probe, not by unit tests. |
| `tests/test_http_helper.py` (new) | 2 tests against a local echo server: a pre-built signed query arrives intact; ordinary params still work and `None` values are dropped. | Pins the regression above without any network access. |
| `tests/test_zebpay_private.py` (new) | 10 tests: signature vector generated by running the official client's algorithm in Node, `encodeURIComponent` equivalence, wire-format/signature coverage, balance + order parsing, the single seconds retry, no retry on `2002`, error translation, refusal of order paths, capability honesty. | Cross-implementation proof instead of a self-comparison. |
| `tests/test_connections.py`, `tests/test_adapters.py` | Updated the two assertions that encoded the old "ZebPay private is unsupported" state; added an API-level test for the new read endpoint (401 without session, 404 without credentials, 502 rather than invented balances when upstream is unreachable). | The old expectations would have hidden a real capability change. |
| `docs/ZEBPAY-API-ASSESSMENT.md` (new) | Evidence table for every claim, the three findings below, and the exact questions that unblock order placement. | Future readers must be able to re-check this decision against primary sources. |

### Findings worth acting on

1. **The official Python client is unsafe.** `zebpay_spot_client.py` sends `X-API-KEY` and
   `X-API-SECRET` as plain headers and never signs anything — it transmits the API secret on every
   request. Live probing shows those headers are ignored by the API (the server falls back to JWT).
   Do not use it, and do not copy its pattern.
2. **The documented npm package does not exist** (`@zebpay/spot-api-client` → 404) and neither does
   the documented PyPI package (`zebpay-spot-client` → 404), so the documented install paths are
   broken. The official Node client's config also points at the staging host `www.zebstage.com`.
3. **The documented `GET /api/v2/time` is a 404**, so client clock skew cannot be measured before
   signing. The adapter retries once with the other documented timestamp unit and records which one
   worked, but a real key is needed to settle it.

### Verification for this pass

| Check | Result |
|---|---|
| `pytest -q` | **41 passed, 2 skipped** (was 28+2), exit 0 |
| `ruff check app tests` | **All checks passed!** |
| Live probe, no credentials | `/api/v2/account/balance` and `/api/v2/ex/orders` both `401`; with `x-auth-apikey` + `x-auth-signature` the server answers `"invalid api key"` (API-key branch reached); with `X-API-KEY`/`X-API-SECRET` it answers `"token contains an invalid number of segments"` (headers ignored); with the headers but no query `timestamp` it answers `400 "Missing timestamp."` |
| Live probe with the adapter's own signer | request signed by `sign_query()` with a dummy key reaches the same `"invalid api key"` branch — before the `http.py` fix this failed with `400 "Missing timestamp."`, which is how the query-dropping bug was found |
| Live API path | `/api/connections/zebpay/account` → `502` with `"invalid api key"`; `/api/connections/zebpay/test` → `state=ERROR`, reason persisted; Binance path unchanged (`451` + geo note) |
| Real account read | **Not performed** — no ZebPay credentials exist here, so `account_balances` stays `verified_docs`, never `verified_live` |

## Not done in this pass (tracked in the roadmap)

Order routing, streaming, AI/Kronos, backtesting, paper trading, learning pipeline, wallets,
Hummingbot, Alembic migrations, cookie sessions + CSRF, rate limiting, audit read API. Live trading
remains blocked by the same three independent gates as before.
