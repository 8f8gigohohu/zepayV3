# DarkDevil Quant

Professional multi-exchange crypto trading platform. The current working milestone delivers
authentication with roles, an append-only audit trail, an exchange-adapter framework with live public
market data (Binance + ZebPay), a fail-closed risk engine, and a responsive dark trading workspace.

> Trading is disabled by default and cannot be enabled until adapters are verified as capable of safe
> order execution. No component here fabricates market or account data: every response carries
> provenance and freshness labels, and every unavailable capability says so on the page that would
> otherwise use it.

## What the workspace contains today

| Section | State | Notes |
|---|---|---|
| Dashboard | Live | System/risk strip, selected market with price/24h/spread, real order book, recent trades, capability report |
| Markets | Live | Searchable live tickers, candlestick chart with 1m–1d intervals, provenance + stale warnings |
| Exchange Connections | Partial | Encrypted credential storage, real read-only account test (Binance + ZebPay balances), masked keys, lifecycle states |
| Risk Management | Partial | Exact gate/limit values from the backend; admin kill-switch control (audited) |
| System Health | Live | Health, database, environment, version, live exchange reachability, capability matrix |
| Settings & Security | Partial | Account/role, session, documented security controls and known gaps |
| Orders & Trades, Portfolio, Paper Trading, AI Lab, Strategies, Backtesting, Wallets, Activity & Audit | Planned | Honest development pages stating milestone, blocker and planned scope — no simulated data |

Navigation status badges (`LIVE` / `PARTIAL` / `PLANNED`) reflect what the backend can actually do.

## Quickstart (dev)

```bash
# backend (Python 3.11+)
cd backend
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp ../.env.example ../.env        # or export DJQ_* vars
.venv/bin/python -m pytest -q      # 41 passed, 2 skipped
.venv/bin/python -m uvicorn app.main:app --port 8000

# frontend (Node 20+)
cd ../frontend
npm install
npm run dev                       # http://localhost:3000 (API proxied to :8000)
```

First registered user becomes the platform admin. Windows 11 users: see
[`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md) for exact PowerShell commands and troubleshooting.

## Operations

- `backend/.venv/bin/python scripts/doctor.py` — dependency, secret-hygiene, database and live
  exchange-connectivity doctor. Run it with the backend interpreter (it imports the backend package).
- `docker compose up -d --build` — production-style stack (Postgres, Redis, backend, frontend; DB and
  Redis are NOT exposed to the host).
- Generate `DJQ_SECRET_KEY` with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.
- Update/rollback: pull new code, run tests, `docker compose up -d --build`; database volumes persist;
  rollback = redeploy the previous commit.

## Exchange connections

Credentials are submitted only to authenticated backend endpoints, stored encrypted at rest, and never
returned by any endpoint (only a masked key is shown). Connection state is derived from evidence:

`NOT_CONFIGURED` → `CONFIGURED_UNTESTED` → `CONNECTED_READ_ONLY` | `ERROR` | `UNSUPPORTED`

A stored key is never reported as a connection, and a successful account read is never reported as
trading readiness — `place_order` is a separate capability and is reported separately.

Private reads implemented today: Binance `GET /api/v3/account` and ZebPay
`GET /api/v2/account/balance` + `GET /api/v2/ex/orders` (docs-verified, HMAC schemes cross-checked
against the official clients). ZebPay order placement stays refused until its docs stop contradicting
themselves — the evidence and the questions to ask ZebPay are in
[`docs/ZEBPAY-API-ASSESSMENT.md`](docs/ZEBPAY-API-ASSESSMENT.md).

## Docs

| Document | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Module map, data-provenance contract, risk engine design, deployment notes |
| [`docs/BASELINE-REPORT.md`](docs/BASELINE-REPORT.md) | Milestone 0 audit: what exists, what works, what is missing, technical debt |
| [`docs/UPGRADE-ROADMAP.md`](docs/UPGRADE-ROADMAP.md) | M0–M7 plan with file-level changes, acceptance tests and rollback |
| [`docs/FEATURE-CAPABILITY-MATRIX.md`](docs/FEATURE-CAPABILITY-MATRIX.md) | Implemented / partial / missing / unsupported per area |
| [`docs/ACCEPTANCE-M1.md`](docs/ACCEPTANCE-M1.md) | Milestone 1 acceptance evidence (live vs fixture-tested vs unverified) |
| [`docs/ZEBPAY-API-ASSESSMENT.md`](docs/ZEBPAY-API-ASSESSMENT.md) | ZebPay spot private API: what the official sources say, what is implemented, why order placement is still refused |
| [`docs/CHANGELOG-M1-UPGRADE.md`](docs/CHANGELOG-M1-UPGRADE.md) | Every file changed in the upgrade pass and why |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Secrets, access control, known trade-offs, rotation and incident response |
| [`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md) | Windows 11 setup, backup/rollback, troubleshooting |

## Roadmap

1. **M1 (shipped)** — architecture, auth/audit, adapters + live public data, risk gates, workspace UI
2. **M2** — secure connections: cookie sessions + CSRF, rate limiting, Alembic migrations, audit read API
3. **M3** — verified streaming where supported, market analytics, stale/gap handling
4. **M4** — AI Trading Lab, Kronos adapter boundary, strategy registry, reproducible experiments
5. **M5** — backtesting, deterministic paper trading, controlled learning pipeline, Phantom wallets
6. **M6** — verified Hummingbot connector capabilities, order lifecycle and reconciliation
7. **M7** — deployment hardening, backups, readiness checks, final acceptance

See [`docs/UPGRADE-ROADMAP.md`](docs/UPGRADE-ROADMAP.md) for per-milestone acceptance criteria.
