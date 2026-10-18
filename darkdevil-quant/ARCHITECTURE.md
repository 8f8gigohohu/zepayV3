# DarkDevil Quant — Architecture (Milestone 1 of 7)

A modular multi-exchange crypto trading platform. **Policy: verified facts or explicit
status labels — never assumed connectivity.** Billion-dollar rule: correctness and
capital survival over feature claims.

## Module map

```
repo/
├── backend/            FastAPI (api) + adapters + risk engine + persistence
│   └── app/
│       ├── auth/       register/login/RBAC (JWT) + deps
│       ├── routers/    system, markets, connections(creds), trading
│       ├── exchanges/  base contract, http client, binance.py, zebpay.py, registry.py
│       ├── risk/       engine.py  (independent, fail-closed)
│       ├── models.py   users, audit_log, exchange_credentials, settings
│       └── db.py       SQLAlchemy async engine (SQLite dev / Postgres prod)
├── frontend/           Next.js 15 + TS + Tailwind v4 dark terminal workspace
│   ├── app/            route per section (dashboard, markets, exchanges, risk, system, …)
│   ├── components/     Shell (sidebar), StatusBadge, DataFreshness, CapabilityMatrix,
│   │                   States (loading/empty/error/dev), ConfirmDialog, CandleChart, PlannedPage
│   └── lib/            api client (typed, status-aware) + sections (nav + honest statuses)
├── scripts/            doctor.py
├── docs/               BASELINE-REPORT, UPGRADE-ROADMAP, FEATURE-CAPABILITY-MATRIX,
│                       ACCEPTANCE-M1, CHANGELOG-M1-UPGRADE, SECURITY, WINDOWS-SETUP
└── docker-compose.yml  postgres + redis + backend + frontend (no DB port exposure)
```

## Verified external integrations (see docs/ACCEPTANCE-M1.md for evidence)

- **Binance**: public data through the official market-data-only host; private endpoints
  implemented per official docs (`HMAC-SHA256`, `X-MBX-APIKEY`), live verification pending
  from a non-geo-restricted deployment.
- **ZebPay** (`sapi.zebpay.com`, official reference repo linked from apidocs.zebpay.com):
  public data verified live; private reads (balances, order list) implemented from the official
  Spot client's canonical signing (HMAC-SHA256 over the exact query string, millisecond
  `timestamp`, `x-auth-apikey`/`x-auth-signature`) and labeled `verified_docs` — headers and
  timestamp placement confirmed live, a real account read is not. Order placement/cancel stay
  refused because the official sources contradict each other on the order body and cancel paths
  (`docs/ZEBPAY-API-ASSESSMENT.md`). Futures is a separate host and is NOT conflated with spot.
- **Hummingbot (M3 plan)**: Apache-2.0, Python ≥3.10.12; V2 controllers + separate
  Hummingbot API service; no official ZebPay connector exists — any custom connector will
  be built against the documented connector architecture and tested before labeling.
- **Kronos (M4 plan)**: MIT license; checkpoints on HuggingFace `NeoQuasar/` (mini/small/base);
  torch ≥2.0; outputs an OHLCV+amount frame; forecasts will always be labeled as model
  estimates with checkpoint identity, never as market data.

## Connection lifecycle contract

Exchange credential state is derived from evidence on every read, never stored as a promise:
`NOT_CONFIGURED` → `CONFIGURED_UNTESTED` → `CONNECTED_READ_ONLY` / `ERROR` / `UNSUPPORTED`. The test
endpoint persists its status, reason and timestamp; a successful account read is reported as read-only
and `place_order` is reported as its own capability. `VERIFIED_FOR_TRADING` is unreachable while no
adapter implements order placement.

Read-only snapshots are exposed at `GET /api/connections/{exchange}/account` (balances for Binance and
ZebPay). The endpoint decrypts the stored secret server-side, signs upstream, and returns the
normalized snapshot with provenance; it never returns the key or the secret.

## Data provenance contract

Every API response is wrapped in an Envelope: `{exchange, endpoint, source_url, verified,
ts_ms, upstream_ts_ms, stale_after_ms, age_ms, data}`. The UI renders origin + freshness
and shows stale-data warnings; the risk engine refuses orders when market data is stale.

## Risk engine (independent, fail-closed)

Order requests pass through: kill switch (DB-backed) → global live-trading gate →
adapter capability check (`place_order` must be verified-live) → notional/exposure limits →
stale-data check → idempotency guard. Any failed check rejects and audits the attempt.
Three independent disable layers exist in M1 (config flag, kill switch default, unverified
adapter capabilities) — releasing any single one cannot allow trading.

## Deployment notes

- Dev: SQLite default; production: Postgres via `docker-compose.yml` (DB/Redis are
  internal-only). AI model/dataset directories can be relocated to a non-OS drive in M4
  via a documented env path (Windows 11 laptop friendly).
- `python scripts/doctor.py` checks tools, deps, secret hygiene, DB, and live exchange
  reachability and exits non-zero on hard failures.
