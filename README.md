# ZebPay–Kronos Trading Terminal

A paper-first, self-hosted terminal for **ZebPay INR spot markets**. The project combines a React 18/Vite dashboard with a FastAPI API, exchange-backed market data, a persistent paper-order ledger and execution journal, read-only live account access, server-side risk controls, and optional Kronos forecasts.

> **Risk notice:** Digital-asset trading can lose money. Forecasts are uncertain research outputs, not investment advice. Paper mode is the default. Live ZebPay order placement, cancellation, and autonomous live strategy execution are intentionally disabled: official ZebPay references and clients conflict on write contracts, and this app does not send live write requests.

## Safety and scope

- **No sample market feed.** Prices, depth, public trades, and candles come from ZebPay through the pinned CCXT ZebPay adapter. If ZebPay data is unavailable, the API reports an error and the UI shows an empty/unavailable state; it does not substitute generated or sample prices.
- **Paper mode** starts with local simulated INR cash (default ₹500,000). Paper orders are recorded locally and can fill against the current ZebPay best bid/ask. Paper fills are simulations, not exchange executions; the paper wallet is not a ZebPay balance.
- **Live account access is read-only.** Operator authentication protects credentials and private-account reads. Live order placement, cancellation, and live strategy starts are rejected by the server regardless of environment flags or connection-test results. The browser never receives exchange secrets.
- The terminal supports local paper limit-order simulation only. It does not support live market/limit orders, margin/leverage, Futures, deposits, withdrawals, wallet sends, or address creation.
- The dashboard emergency stop halts strategy execution but does not close positions or send live cancellation requests. Manage any real exchange orders directly in ZebPay.
- The Hummingbot connector directory is a separate legacy integration, not governed by this dashboard's fail-closed checks. Do not use it with live credentials; independently review and verify that integration before any deployment.

## Features

- React 18, Vite, Tailwind CSS, Zustand, and TradingView Lightweight Charts candlesticks; responsive dark trading-terminal layout.
- FastAPI REST endpoints and an authenticated WebSocket event stream for market, order, risk, strategy, and forecast updates.
- CCXT ZebPay Spot adapter for public market data and read-only private account access, with safe-read retries and circuit-breaker protection. The app has no live exchange write route.
- Persistent SQLite order/paper-balance storage and SQLAlchemy fill journal with mode-separated positions, average cost, realized P&amp;L, fees, and risk events.
- Layered server-side controls: INR-pair allowlist, per-order and daily notional caps, order-count cap, balance checks, price deviation, tracked-position limits, daily loss/trade caps, loss cooldown, and drawdown circuit breaker.
- Optional Kronos predictor with lazy model loading and cache. A deterministic EMA-plus-momentum fallback is available when configured. Forecasts never submit orders by themselves.
- In-app **Connections & Security** setup for ZebPay Spot credentials, operator-password rotation, read-only market/account connectivity checks, and hard-risk visibility. No live-order arm is available.
- Hummingbot ZebPay Spot connector extension under `integrations/hummingbot/connector/exchange/zebpay/`.

## ZebPay Spot API integration

The dashboard connects to `https://sapi.zebpay.com` through the pinned CCXT ZebPay Spot adapter (`ccxt==4.5.88`) for public market data and read-only private account/order reads. Authentication uses `X-AUTH-APIKEY` and `X-AUTH-SIGNATURE`; credentials remain server-side and are never returned to the browser. The adapter's order-create/cancel capabilities are not exposed by the app.

The official ZebPay references and client implementations conflict on live order payloads and cancellation routes. Until ZebPay clarifies those contracts and they are independently verified, this app deliberately refuses live placement and cancellation without making a request. Successful connectivity checks or market reads do not change that policy. Local tests exercise read-only adapter signing; they do not verify live connectivity, credentials, or order execution.

The browser's `/api/ws` connection is the terminal's own event channel, not a direct subscription to a ZebPay WebSocket. The dashboard uses REST for ZebPay market/account reads. Do not configure the terminal as a WebConsole OAuth redirect client; those callback fields are not consumed here.

Reference: [ZebPay API docs](https://apidocs.zebpay.com/) and the [official Spot API reference repository](https://github.com/zebpay/zebpay-api-references/tree/main/spot/api-reference).

## Run locally

Requirements: Python 3.11 recommended (Python 3.10+ may work), Node.js 20+, and npm.

### Backend

```bash
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
cp .env.example .env                   # optional; defaults to paper mode
./run.sh
```

### Frontend development server

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies relative `/api` and WebSocket requests to the FastAPI server at `http://127.0.0.1:8000` (override the server-side proxy target with `VITE_API_TARGET`). Browser code uses same-origin `/api` paths.

To build the static React bundle for FastAPI, run:

```bash
cd frontend
npm run build
```

The build is emitted to `web/`, which the FastAPI app serves. The build output is checked in so the backend can serve the dashboard without a separate frontend process.

### Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8000`. Compose persists the SQLite database and mutable runtime configuration in a named volume; the initial runtime configuration is seeded from `config.yaml`. To use Kronos in the container, place the upstream source at `models/Kronos/`, install the optional inference dependencies into a custom image, and configure model access. The default image deliberately omits large Torch/GPU packages.

## Configuration

- `.env` provides server-side account, auth, hard risk caps, CORS origins, database path, and model source settings. Never commit `.env` or put credentials in browser storage.
- The dashboard's **Settings** section can initialize operator access and save/rotate ZebPay Spot keys. Secret values are never read back into the page. Dashboard-managed secrets are stored in `data/private_settings.json` (owner-only permissions, mode `0600`) and take precedence over `.env` values; set `PRIVATE_SETTINGS_PATH` to change the file path. This file is not encrypted at rest, so protect the server filesystem/backups or use a secret manager for production.
- On first setup, the server creates a one-time code at `data/initial-setup.token` with mode `0600`. Open the file locally and enter its contents in Settings along with the ZebPay key/secret and a new operator password. The code is consumed after setup and is never returned by an API; existing keys are never prefilled into the browser.
- `config.yaml` is the initial application/runtime configuration (exchange rate/retry options, strategy defaults, forecast settings, risk settings, paper-account behavior, database description, and UI refresh preferences).
- Runtime strategy settings persist as YAML. In Docker, the mutable copy is `/app/data/runtime.yaml`; locally it defaults to `config.yaml`. The `PUT /api/strategy/config` endpoint cannot loosen the hard limits supplied through server environment settings.
- Strategy auto-start is disabled on process startup, even if a previous runtime file recorded it as enabled.

Useful environment values are documented in `.env.example`. Defaults include:

```dotenv
TRADING_MODE=paper
LIVE_TRADING_ENABLED=false
AUTO_LIVE_TRADING_ENABLED=false
ALLOWED_SYMBOLS=BTC/INR,ETH/INR
MAX_ORDER_NOTIONAL=25000
MAX_DAILY_NOTIONAL=100000
MAX_OPEN_ORDERS=8
MAX_POSITION_BASE=0.001
MAX_DAILY_LOSS_QUOTE=5000
MAX_DAILY_TRADES=50
COOLDOWN_AFTER_LOSS_SEC=300
CIRCUIT_BREAKER_PCT=0.05
```

## Read-only live-account access and write policy

`TRADING_MODE=live` selects the authenticated, read-only account view; it does **not** authorize trading. Live order placement and cancellation return a fail-closed error before any exchange request, and live strategy starts are rejected. The emergency stop halts the local strategy but never calls ZebPay to cancel orders or close positions. `LIVE_TRADING_ENABLED` and `AUTO_LIVE_TRADING_ENABLED` are reported as configured intent only and cannot override this policy.

To enable read-only private account access, configure ZebPay credentials in **Connections & Security** and complete operator setup over HTTPS. Use the least-privileged key that can read the account data you need; do not grant order-create, wallet-send, address-creation, withdrawal, or Futures permissions. The exchange may change its permission labels, so verify the current options with ZebPay. Credentials are stored server-side; do not commit or paste them into chat. For production, set secure cookies and use a secret manager or protected server storage.

```dotenv
TRADING_MODE=live
LIVE_TRADING_ENABLED=false
AUTO_LIVE_TRADING_ENABLED=false
ZEBPAY_API_KEY=read_only_spot_key
ZEBPAY_SECRET_KEY=read_only_spot_secret
APP_PASSWORD=at-least-12-random-characters
JWT_SECRET=at-least-32-random-secret-characters
SECURE_COOKIE=true
```

These settings expose balances and order history after operator authentication; they do not enable exchange order writes. Manage real orders directly in ZebPay.

## Kronos forecasting (optional)

The adapter targets [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), loads lazily, and is disabled by default. Install the source and optional dependencies:

```bash
git clone https://github.com/shiyu-coder/Kronos.git models/Kronos
pip install -r requirements-kronos.txt
```

Configure `KRONOS_PATH`, model/tokenizer names and `KRONOS_DEVICE` in `.env`, then enable the runtime Kronos setting in the strategy panel or YAML. Hugging Face weights may be large and require their own cache/disk budget. When enabled, Kronos inference can fall back to the deterministic statistical predictor if `use_fallback` is enabled. No model inference or forecast accuracy claim has been verified here.

## Hummingbot connector (optional)

This repository includes an independent Hummingbot ZebPay Spot connector at `integrations/hummingbot/connector/exchange/zebpay/`; it does not vendor Hummingbot itself. Copy it into the matching Hummingbot source tree and use that release's documented development workflow:

```bash
cp -R integrations/hummingbot/connector/exchange/zebpay \
  /path/to/hummingbot/hummingbot/connector/exchange/
```

The connector implementation is version-sensitive and outside the dashboard's fail-closed policy. Build and test it against the exact Hummingbot version you deploy, and use paper trade only. Do not provide it a live key: its API key, session, order sizing, and risk controls are separate from this dashboard and have not been independently reviewed or verified for live use.

## REST and WebSocket API

Interactive OpenAPI docs: `GET /api/docs`.

- Public: `GET /api/health`, `/api/status`, `/api/config`, `/api/markets`, `/api/market`, `/api/market/orderbook`, `/api/market/trades`, `/api/candles`, `/api/strategy/signals`, `/api/strategy/forecast` (also `/api/forecast`).
- Authenticated live account reads: `GET /api/portfolio`, `/api/positions`, `/api/orders`, `/api/journal/trades`, and `/api/risk`. `POST /api/orders` and `DELETE /api/orders/{client_order_id}` are paper-only; in live mode, create/cancel requests are rejected before contacting ZebPay.
- Strategy/risk controls: `GET|PUT /api/strategy/config`, `GET /api/strategy/status`, `POST /api/strategy/start`, `/api/strategy/stop`, `/api/strategy/emergency-stop`, `/api/risk/resume`.
- Operator setup/session: `POST /api/auth/bootstrap` (one-time local setup code), `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`.
- Settings (operator session required): `POST /api/settings/credentials`, `/api/settings/password`, `/api/settings/test-connection`, `/api/settings/live-arm`. The legacy live-arm route permits disarming but refuses arming.
- WebSocket: `/api/ws`. Live-mode sockets require the operator HttpOnly session cookie.

The service remains paper-first and fails closed when exchange market data is unavailable. Paper balances and fills are simulated locally; live account data is read-only, and the service does not submit or cancel live orders.

## Tests and checks

```bash
pip install -r requirements-dev.txt
pytest -q
cd frontend && npm ci && npm run build
```

Tests use local fakes and SQLite; they do not call ZebPay, verify live credentials, load Kronos weights, or place orders. Hummingbot extension compatibility should be tested separately against the exact Hummingbot release.
