# DarkDevil Quant — Windows 11 setup guide

Everything below runs on a stock Windows 11 machine with PowerShell. Commands are exact; the
alternatives for an unsupported shell are noted. Nothing here requires a GPU or an AI model — the
dashboard and market data work without any model installed.

## 1. Install prerequisites

```powershell
winget install --id Python.Python.3.12 -e
winget install --id OpenJS.NodeJS.LTS  -e
winget install --id Git.Git            -e
```

Close and reopen PowerShell afterwards, then confirm:

```powershell
python --version    # 3.11 or newer
node --version      # 20 or newer
git --version
```

Docker Desktop is optional and only needed for the containerised stack (section 6).

## 2. Get the code

```powershell
cd $HOME\projects
git clone https://github.com/8f8gigohohu/darkdevil-quant.git
cd darkdevil-quant
```

## 3. Configure environment

```powershell
Copy-Item .env.example .env
# Generate a strong signing key and paste it into .env as DJQ_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Notes:
- `.env` is gitignored. Never commit it.
- `DJQ_SECRET_KEY` signs tokens and derives the encryption key for stored exchange credentials.
  Changing it later invalidates existing sessions and stored credentials (they must be re-entered).
- Leave `DJQ_LIVE_TRADING_ENABLED=false`. Trading is fail-closed regardless — see section 5.

## 4. Run the backend and the dashboard

Two PowerShell windows.

**Window 1 — backend**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -e ".[dev]"
.\.venv\Scripts\python -m pytest -q                 # expect: 28 passed, 2 skipped
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Window 2 — frontend**

```powershell
cd frontend
npm install
npm run dev                                          # http://localhost:3000
```

Open <http://localhost:3000>. The frontend proxies `/api/*` to the backend, so the browser only ever
talks to one origin (no CORS configuration needed).

The first account you register becomes the platform admin; later accounts are viewers.

Health and diagnostics:

```powershell
# from the repo root, using the backend venv so dependencies are visible
backend\.venv\Scripts\python scripts\doctor.py
```

```
✓ python3 / ✓ node / ✓ npm
✓ python deps: all importable
✓ DJQ_SECRET_KEY: set
✓ live trading: disabled (safe default)
✓ kill switch default: active
✓ database (sqlite+aiosqlite)
✓ exchange binance / zebpay: reachable (live public API)
FAILURES: 0
```

If you run `python scripts\doctor.py` with a Python that does not have the backend dependencies, the
doctor exits 1 with the exact install command instead of a traceback — that is expected.

Browse the API directly: <http://127.0.0.1:8000/api/docs>

## 5. What works today (and what does not)

Working: live public market data (Binance market-data-only host, ZebPay), authentication with roles
and an append-only audit trail, encrypted exchange-credential storage with read-only verification,
the risk-engine view, system health, and the full navigation shell.

Not implemented (the UI says so on every affected page): order placement, order history, balances,
streaming, backtesting, paper trading, AI/Kronos, wallets, Hummingbot.

Live trading is blocked by three independent gates: the configuration flag
(`DJQ_LIVE_TRADING_ENABLED`), the database-backed kill switch (default active) and the absence of any
implemented `place_order` adapter capability. Releasing one gate cannot enable trading.

## 6. Optional — containerised stack (Postgres + Redis)

```powershell
docker compose up -d --build
docker compose ps
```

Postgres and Redis are not published to the host; only the backend (8000) and frontend (3000) are.
Stop with `docker compose down` (add `-v` to also delete the database volume — that deletes data).

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `python` opens the Microsoft Store | Python is not installed or the App Execution Alias wins. Install Python 3.12 (section 1) and disable the alias in Settings → Apps → Advanced app settings → App execution aliases. |
| `pytest` → "no tests ran" | You are not in `backend/`, or you used a system Python without dev extras: install with `.\.venv\Scripts\pip install -e ".[dev]"`. |
| `executionpolicy` error when running npm scripts | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, then rerun the command in that window. |
| Frontend loads but every panel says data unavailable | The backend is not running or is on another port. Start window 1, then check <http://127.0.0.1:8000/api/system/health>. |
| Exchange shows `UNREACHABLE` / `GEO-RESTRICTED` | Your network or region is blocked by that exchange (Binance returns HTTP 451 from some locations). The UI reports this honestly; no values are substituted. |
| `scripts\doctor.py` reports missing python deps | Run it with the backend venv interpreter (section 4), not a system Python. |
| Port already in use | Find and stop the listener: `netstat -ano \| findstr :8000` then `Stop-Process -Id <pid>`. |

## 8. Updating, backup and rollback

```powershell
git pull
cd backend; .\.venv\Scripts\python -m pytest -q; cd ..
cd frontend; npm install; npm run build; cd ..
```

- SQLite dev database: `data\darkdevil.db`. Back it up by copying the file while the backend is
  stopped. Postgres deployments: `docker compose exec db pg_dump -U djq darkdevil > backup.sql`.
- Rollback = check out the previous commit and restart. Database schema changes are not yet
  migration-managed (Alembic is a Milestone 2 item), so treat schema changes carefully.
- Dependency updates: `npm outdated` / `npm update` in `frontend`, `.\.venv\Scripts\pip list --outdated`
  in `backend`; run the test suite and `npm run build` after any update.
