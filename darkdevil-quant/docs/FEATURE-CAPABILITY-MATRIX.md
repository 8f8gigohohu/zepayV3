# DarkDevil Quant — Feature Capability Matrix

Based on the current codebase (last reviewed at commit `0e8fc04`). Truthful states only.

## Legend
- **Implemented** — code exists and verified (tests or live checks as noted)
- **Partial** — wired but incomplete or UX polish needed
- **Missing** — not present
- **Unsupported** — upstream does not support or explicitly not implemented by policy
- **Verified** — tested against real service or fixture-verified with evidence
- **Docs-verified** — implemented per official docs, live not yet exercised

## 1) Frontend (UI/UX)
| Feature | State | Notes |
|---|---|---|
| Dashboard (system health, live ticker, exchange matrix) | Implemented (Verified) | Shows provenance/freshness, honest states. |
| Markets (searchable tickers, freshness/stale) | Implemented (Verified) | REST polling; labels no WS. |
| Login/Register (first user admin) | Implemented (Verified) | JWT stored in localStorage (noted trade-off). |
| Nav/status badges (live trading, env, M1) | Implemented (Verified) | Reads `/api/system/health`. |
| Exchange Connections UI (connect/test/disconnect, masked keys) | Implemented (Verified live) | Wired to the real endpoints; lifecycle states derived from evidence. |
| Wallets UI (Phantom) | Page exists, capability Missing (M5) | Page states honestly that nothing is implemented; no simulated wallet data. |
| AI Trading Lab | Page exists, capability Missing (M4) | Needs schema + adapter boundary. |
| Strategies/Backtesting/Paper/Portfolio/Risk/Activity/Audit pages | Pages exist, capabilities Missing (M5–M6) | Every page states its milestone, blocker and planned scope; no fabricated values. |
| Candlestick charts, orderbook/depth, trades panels | Implemented (Verified live) | Dashboard order book + recent trades; markets candle chart with 1m–1d intervals, all from live REST data. |
| Responsive design, collapsible sidebar, reusable components | Implemented (M1) | Sidebar shell with grouped navigation, shared status/freshness/empty/error/dialog components. |
| Risk Management view (gates, limits, kill switch) | Implemented (Verified live) | Read-only `GET /api/system/risk` + admin kill-switch control behind a confirmation dialog. |
| System Health view | Implemented (Verified live) | Health, DB, environment, version, exchange reachability, capability matrix. |

## 2) Auth, RBAC, Sessions, Audit
| Feature | State | Notes |
|---|---|---|
| Register/Login/JWT | Implemented (Verified) | HS256, expiry configurable. |
| RBAC (admin/trader/viewer) | Implemented (Verified) | `require_role` on mutating endpoints. |
| First user becomes admin | Implemented (Verified) | Enforced in register. |
| Audit log (append-only) | Implemented (Verified) | No update/delete paths; redaction. |
| Session cookies + CSRF | Missing (M2) | localStorage token (XSS-sensitive). |
| Rate limiting (auth/creds/trading) | Missing (M2) | Defensive. |

## 3) Exchange Adapters & Connectivity
| Feature | State | Notes |
|---|---|---|
| Binance public REST (market-data-only) | Implemented (Verified Live) | `data-api.binance.vision`; exercised live. |
| Binance private (signed account) | Implemented (Docs-verified) | HMAC-SHA256 scheme per docs; live blocked by HTTP 451 from this network. |
| Binance WS market data | Docs-verified / Missing (not proxied) | Names per docs; proxied stream lands M2. |
| Binance order placement/cancel/history | Not Implemented (by policy) | Planned M2–M3 after hardening. |
| ZebPay public REST (tickers/orderbook/trades/klines) | Implemented (Verified Live) | klines epoch-seconds confirmed by live probing. |
| ZebPay private signing (HMAC-SHA256, query-string canonicalisation) | Implemented (Docs-verified) | Matches the official Spot Node client's algorithm byte-for-byte; header names confirmed by live probe. See `docs/ZEBPAY-API-ASSESSMENT.md`. |
| ZebPay read-only balances / order list | Implemented (Docs-verified) | Signed `GET /api/v2/account/balance` and `GET /api/v2/ex/orders`; exposed via `GET /api/connections/{exchange}/account`. No real account read from this environment. |
| ZebPay order placement / cancel | Not Implemented (policy) | Official docs and clients contradict each other on body fields and cancel/detail paths; a guessed order body is an uninsured financial action. `place_order`/`cancel_order` refuse. |
| ZebPay sandbox | Unavailable | No sandbox/UAT URL documented. |
| ZebPay WS | Unsupported (upstream) | No public spot WS documented. |
| Adapter capability matrix (honest) | Implemented (Verified) | UI/API surface states explicitly. |
| Connection test (private) reports exact reasons | Implemented (Verified live) | Persists status, reason and timestamp; Binance → ERROR (HTTP 451), ZebPay → ERROR (unreachable upstream in tests) or CONNECTED_READ_ONLY with real keys. Never UNSUPPORTED while a private read exists. |
| Encrypted credential storage + masked keys | Implemented (Verified) | Never returns secrets; tests assert key/secret cannot appear in responses. |
| Connection lifecycle states (NOT_CONFIGURED … UNSUPPORTED) | Implemented (Verified live) | Derived from evidence only; a stored key is never reported as connected. |

## 4) Risk Engine & Safety
| Feature | State | Notes |
|---|---|---|
| Independent fail-closed risk engine | Implemented (Verified) | kill switch → live trading gate → adapter capability → checks → stale-data. |
| Kill switch (DB-backed, admin-only) | Implemented (Verified) | Audited; activate/release available in the Risk page for admins. |
| Risk configuration read surface | Implemented (Verified live) | `GET /api/system/risk` exposes the exact gates/limits the engine uses. |
| Global live-trading gate (env) | Implemented (Verified) | Hard-disabled by default in M1. |
| Stale-market-data rejection (30s) | Implemented (Verified) | Enforced in risk check. |
| Idempotency guard (in-memory) | Partial (M1) | DB-backed uniqueness planned M2. |
| Pre-trade limits (notional/exposure/daily loss/drawdown) | Partial (M1) | Basic notional checks present; expanded M6. |
| Duplicate/replay protection (DB) | Missing (M2) | Strengthen for live path. |

## 5) Market Data & Streaming
| Feature | State | Notes |
|---|---|---|
| REST tickers/klines/orderbook/trades with Envelope | Implemented (Verified) | Provenance + freshness on every response. |
| Stale detection in UI | Implemented (Verified) | Shows warnings when age>stale_after_ms. |
| WS streaming (reconnect/backpressure/heartbeats) | Missing (M3) | REST is fallback and labeled. |
| Gap detection/monitoring | Missing (M3) | Add with bounded backoff. |

## 6) AI, Kronos, Learning
| Feature | State | Notes |
|---|---|---|
| AI Trading Lab UI | Missing (M4) | Schema-driven. |
| AI decision schema (validated) | Missing (M4) | action/confidence/reason_codes/evidence/risk_checks/versions/created_at. |
| Model adapter boundary (noop+kronos) | Missing (M4) | Disabled state if unavailable; timeouts bounded. |
| Kronos model integration | Missing (M4) | Inspect license/artifacts/hardware first; optional remote inference. |
| Baseline comparison | Missing (M4) | Against holdout + transaction costs/slippage. |
| Learning pipeline (versioned records, controlled promotion) | Missing (M5) | Requires min samples, OOS, walk-forward, cost stress, human approval, no auto-promo. |

## 7) Backtesting, Paper Trading, Strategies
| Feature | State | Notes |
|---|---|---|
| Backtesting engine (deterministic) | Missing (M5) | No look-ahead, fees/slippage, train/val/holdout, walk-forward. |
| Paper trading (simulated exchange, labeled) | Missing (M5) | Models fills/fees/slippage/latency; labeled SIMULATED. |
| Strategy registry/experiments | Missing (M5) | Versioned configs/reports. |

## 8) Hummingbot
| Feature | State | Notes |
|---|---|---|
| Hummingbot boundary/isolation | Missing (M6) | Connector capability discovery. |
| Verified connector support (incl. ZebPay) | Missing (M6) | Do not assume ZebPay connector exists; verify first. |
| Order lifecycle/reconciliation via Hummingbot | Missing (M6) | Only verified capabilities; live disabled until acceptance passes. |

## 9) Wallets (Phantom)
| Feature | State | Notes |
|---|---|---|
| Wallets center (separate from exchange) | Missing (M5) | Clear separation; no mixing balances. |
| Phantom connect/disconnect, address display, network | Missing (M5) | Only verified networks/providers. |
| Read-only balances/tx history (if supported) | Missing (M5) | Reliable source only. |
| Transaction signing with explicit approval | Missing (M5) | Never request seed/private key; never custody. |
| Network mismatch/rejected signatures handling | Missing (M5) | Safe UX. |

## 10) Ops, Infra, Security Hardening
| Feature | State | Notes |
|---|---|---|
| SQLite dev / Postgres prod config | Implemented (Verified) | Compose has Postgres+Redis internal-only. |
| Dockerfiles + docker-compose | Implemented (Partial) | Images exist; end-to-end compose validation planned M7. |
| `scripts/doctor.py` | Implemented (Verified) | Checks tools/deps/secrets/DB/exchange reachability. |
| Alembic migrations | Missing (M2) | Replace create_all over time. |
| Health/readiness checks | Partial (M1) | `/api/system/health` exists; readiness checks to add M7. |
| Backups/restore, safe shutdown | Missing (M7) | Documented procedures. |
| Dependency updates guidance | Missing (M7) | Windows 11 + troubleshooting. |
| No secrets in repo/logs/responses | Implemented (Verified) | Redaction + encryption at rest. |
| Windows 11 setup guide | Partial | README has quickstart; expand in M7. |

## Summary
M1 foundation is **Implemented/Verified** for public data, auth/audit, risk safety, honest capability labeling. Major UX expansion (Connections, Wallets, AI, Backtesting, Paper, Learning, Streaming, Hummingbot) is **Missing/Partial** and planned per roadmap with explicit acceptance criteria and no weakening of safety gates.