# DarkDevil Quant — Milestone 1 Acceptance Report

Date: 2026-10-17. Milestone 1 is **implemented and running**: FastAPI backend with
auth/RBAC/audit, exchange-adapter framework, live public market data for Binance and
ZebPay, risk gates fail-closed, Next.js dark trading workspace. 41 backend tests pass (up from 16
before the upgrade pass and 28 after it — see `docs/CHANGELOG-M1-UPGRADE.md`); frontend production
build passes. ZebPay spot private reads are implemented on top of the official signing scheme.

## How to reproduce

1. Backend: `cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" &&
   .venv/bin/python -m pytest -q && .venv/bin/python -m uvicorn app.main:app --port 8000`
2. Frontend: `cd frontend && npm install && npm run dev` (API proxied to :8000)
3. Doctor: `python scripts/doctor.py`
4. Optional live-network tests: `DJQ_NETWORK_TESTS=1 .venv/bin/python -m pytest -q`

## Verified against REAL services (this deployment, 2026-10-17)

| Integration | Evidence |
|---|---|
| Binance public REST | `ping` 200 on official market-data-only host `data-api.binance.vision`; `ticker/24hr` returned live BTCUSDT (~81.5k USD at time of test) through the platform API |
| ZebPay public REST | `allTickers`, `orderbook`, `trades`, `klines` all returned live data through `https://sapi.zebpay.com/api/v2/...` via the platform API |
| ZebPay klines semantics | docs did not specify units; decided by live probing: epoch-**seconds** params, Binance-style rows. Encoded in adapter + tests |
| Geo-restriction honesty | `api.binance.com` returns HTTP 451 from this network; surfaced in UI/status API instead of being hidden |

## Tested with fixtures (not live data)

- Adapter parsing (Binance ticker, ZebPay tickers/orderbook/trades/klines) in
  `backend/tests/test_adapters.py` — fixture JSON captured from live responses,
  clearly labeled.
- Binance HMAC-SHA256 signing scheme matches the official docs' description.
- All risk-engine and order-gate paths, auth/RBAC flows (synthetic accounts in a temp DB).

Session/test credentials in `backend/tests/*` and the local `data/sandbox.db` are
synthetic fixtures or throwaway sandbox users; they are not production secrets.

## NOT verified / intentionally unimplemented

| Item | State | Why / next step |
|---|---|---|
| Live trading / order routing | Fail-closed rejected | Three independent gates (config, kill switch, unverified adapters). Milestones 2–3 |
| Binance private endpoints | Docs-verified, live UNVERIFIED | HTTP 451 from this network; verify from an unrestricted deployment with read-only keys |
| ZebPay private read (balances, order list) | Implemented, docs-verified, live UNVERIFIED | Signing taken from the official Spot Node client and cross-checked against it; no credentials available here to exercise a real read. Order placement/cancel remain NOT IMPLEMENTED because the official sources contradict each other on the order body and cancel paths — see `docs/ZEBPAY-API-ASSESSMENT.md` |
| WebSocket streaming | Docs-verified names; not proxied | M2 deliverable; markets currently REST-polling and labeled as such |
| Kronos, Hummingbot, wallets | Not started per milestone order | M4 / M3 / M5 |
| Postgres deployment path | Configured via compose + env, not exercised here | Compose stack is provided; run on the target machine |

## Acceptance criteria (from the contract)

- Professional dashboard with live keyless public data — DONE (Binance + ZebPay).
- No fabricated data: every API response carries exchange/endpoint/source/timestamp/
  freshness/staleness; UI renders stale-data warnings and disables nothing silently.
- Tests: 41 passed, 2 skipped (opt-in live-network smoke tests). Sixteen were the original M1 suite;
twelve were added for the connection lifecycle, credential masking and state mapping; thirteen cover
the ZebPay signing canonicalisation, error translation and read-only/refusal contract, including the
query-preservation regression that the live probe exposed.
- Workspace: all fourteen sections exist, with `LIVE` / `PARTIAL` / `PLANNED` badges; nothing is
fabricated on the pages whose backend capability is missing.
- Connections: lifecycle states are derived from evidence (`NOT_CONFIGURED` → `CONFIGURED_UNTESTED` →
`CONNECTED_READ_ONLY` / `ERROR` / `UNSUPPORTED`); a stored key is never reported as connected.
- Docs live in `README.md`, `ARCHITECTURE.md`, `docs/SECURITY.md`, and the
  `.env.example` template with placeholders for every secret.
