# Zepay V3 Trading Desk

A small, self-hosted **ZebPay Spot** trading desk with a web UI, a locally simulated paper account, configurable live-trading gates, and optional Kronos/Hummingbot integrations. The repository started as an empty shell; this project adds the application and integrations rather than copying either large upstream repository wholesale.

> **Trading risk:** crypto orders can lose money. AI/model forecasts and technical indicators are uncertain and are not investment advice. Live trading is deliberately locked by default. Do not enable it until you have reviewed the code, API permissions, and guardrails.

## What is implemented

- Responsive browser dashboard for market quotes, candle chart, INR portfolio, order ticket, research signals, and order history.
- ZebPay Spot access through the supported `ccxt.zebpay` adapter (pinned to a release that includes ZebPay). It uses ZebPay's public and authenticated REST endpoints, exchange market precision, and CCXT signing.
- Paper execution with a persistent SQLite ledger, reserved funds for open limit orders, simulated fills only when a limit crosses the current bid/ask, and a visible offline sample feed when public ZebPay data cannot be reached. Paper fills do not model fees, depth, or slippage.
- Live **spot limit** orders, cancellations, balance checks, exchange precision, current-price band protection, a server-side market allowlist, and per-order/daily/open-order limits. A network timeout after submission is recorded as `unknown`; the app will not blindly retry it.
- Optional SMA 10/30 research indicator. Signals never submit orders.
- Optional adapter to the upstream [Kronos financial-candle model](https://github.com/shiyu-coder/Kronos). Model loading is lazy; Kronos is not required to run the desk and cannot place orders.
- A standalone Hummingbot ZebPay Spot connector extension under `integrations/hummingbot/connector/exchange/zebpay/`. Copy it into a Hummingbot source checkout to use Hummingbot's strategy engine with ZebPay.

**Not included:** market orders, futures, margin/leverage, deposits/withdrawals, or autonomous live model trading. Live exchange requests cannot be tested in this workspace without the operator's ZebPay credentials and access to ZebPay's API hosts.

## Run locally

Python 3.10+ is required (tested with Python 3.11).

```bash
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
cp .env.example .env                   # optional; paper mode is the default
./run.sh
```

Open `http://127.0.0.1:8000` on a local machine. `run.sh` binds to `0.0.0.0` so it can be used by a container/preview; for a personal workstation, prefer:

```bash
python -m uvicorn zepay_trader.main:app --host 127.0.0.1 --port 8000
```

The paper account starts with the configured simulated INR balance (default ₹500,000) and persists orders/balances in `data/zepay.sqlite3`. If the ZebPay public API is reachable, paper mode uses ZebPay's market data but still simulates every fill locally. If it is not reachable, the desk uses deterministic sample candles and quotes and labels them **SIMULATED**. Sample prices are not exchange prices.

Optional API endpoints are listed at `/api/docs`. Health/config responses never include API secrets.

## Enabling real ZebPay Spot trading

Live trading requires **all** of these server-side settings. They are intentionally not editable from the browser:

```dotenv
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
ZEBPAY_API_KEY=your_spot_api_key
ZEBPAY_SECRET_KEY=your_spot_api_secret
APP_PASSWORD=use-a-long-random-operator-password
SECURE_COOKIE=true
```

1. Create a ZebPay API key with only the read and spot-trading permissions the bot needs. **Do not grant withdrawal permissions.** Use IP allowlisting when available and keep the secret on the server only.
2. Put the key/secret in a protected environment or secret manager. Do not commit `.env`, paste credentials into chat, or put them in browser storage.
3. Keep `ALLOWED_SYMBOLS` narrow (default `BTC/INR,ETH/INR`) and start with conservative `MAX_ORDER_NOTIONAL`, `MAX_DAILY_NOTIONAL`, and `MAX_OPEN_ORDERS` values. The trading desk, portfolio valuation, and turnover controls currently support INR-quoted spot markets only; configure additional INR pairs only.
4. Set a strong `APP_PASSWORD` of at least 12 characters, put the desk behind HTTPS, set `SECURE_COOKIE=true`, and do not expose the service directly to an untrusted network. The app currently uses one operator password and in-memory sessions; restart logs out operators. Run a single app worker: the session map and order-admission lock are process-local, and multi-worker deployment is not supported.
5. Restart the app, sign into the operator panel, verify the market and free balance, and test with a very small limit order. The UI asks for a separate confirmation for each live order; the API also requires the exact confirmation phrase.

Guardrails applied before a live order:

- The server must be explicitly in `live` mode and armed, credentials and a strong password must exist, secure cookies must be enabled, and the operator must be authenticated.
- Spot limit orders only; symbol must be in the server-side allowlist.
- ZebPay market amount/price precision and minimums are checked; a value that would need rounding is rejected rather than silently changed. Free balances are checked before sending.
- A buy/sell limit may not sit more than `MAX_PRICE_DEVIATION_PCT` from the current ask/bid (default `0.01`, i.e. 1%). The live price must come from ZebPay; there is no simulated-price fallback in live mode.
- Per-order notional, daily submitted notional, and open-order count are capped. Canceled submissions still count toward the daily cap so repeated cancel/recreate cycles do not bypass it.
- An ambiguous timeout is recorded as `unknown`, not retried. Check ZebPay's order history before taking any further action.

These controls reduce accidental orders but cannot guarantee profit or eliminate exchange, network, market, or software risk. The app does not calculate realized P&amp;L, account-specific taxes/fees, or portfolio-wide INR conversions for unconfigured pairs.

## Kronos integration (optional)

The adapter targets the upstream [`shiyu-coder/Kronos`](https://github.com/shiyu-coder/Kronos) API and its published model zoo. It is disabled by default and performs no execution.

```bash
git clone https://github.com/shiyu-coder/Kronos.git models/Kronos
pip install -r requirements-kronos.txt
```

Then set:

```dotenv
KRONOS_ENABLED=true
KRONOS_PATH=models/Kronos
KRONOS_MODEL=NeoQuasar/Kronos-small
KRONOS_TOKENIZER=NeoQuasar/Kronos-Tokenizer-base
KRONOS_DEVICE=cpu
```

The Hugging Face model weights are fetched/cached by Kronos on the first forecast request. This can require substantial disk, memory, and network access; a GPU is optional. The dashboard's **Run forecast** action only returns a research forecast. It is not wired to order submission or to a live strategy.

## Hummingbot integration (optional)

The connector package is kept separate so this repository does not vendor Hummingbot's full codebase. It follows Hummingbot's `ExchangePyBase` connector contract and is discovered via `zebpay_utils.py`.

Copy the connector into a Hummingbot source checkout, then rebuild/restart that Hummingbot version using its documented development workflow:

```bash
cp -R integrations/hummingbot/connector/exchange/zebpay \
  /path/to/hummingbot/hummingbot/connector/exchange/
```

After the connector is discovered, connect `zebpay` through Hummingbot and use dash-form pairs such as `BTC-INR`. The extension provides API-key signing, public order-book polling, balance polling, limit-order placement/cancellation, and order/fill status polling. ZebPay Spot's published reference does not specify a private websocket stream, so the connector polls REST; it does not pretend to provide websocket updates. Market orders, derivatives, withdrawals, and leverage are intentionally unsupported. Fee defaults follow an exchange-info example (0.45%); set a Hummingbot fee override if your actual ZebPay account tier differs.

This extension is version-sensitive to Hummingbot's Python connector API. Compile and test it in the exact Hummingbot version you deploy, start in Hummingbot paper trade, and only then use a narrowly permissioned API key. Hummingbot connects directly to ZebPay, so this dashboard's operator login, symbol allowlist, price-band check, and notional caps do **not** apply to Hummingbot strategies; configure and test Hummingbot's own strategy sizing/risk limits. The core dashboard does not need Hummingbot installed.

## API overview

- `GET /api/health`, `GET /api/config` — non-secret service and guardrail status.
- `GET /api/market`, `GET /api/candles` — ZebPay market data; paper mode may return labelled simulated data on outage.
- `GET /api/portfolio`, `GET /api/orders` — simulated account data in paper mode; authenticated ZebPay balances and this desk's tracked orders/statuses in live mode.
- `POST /api/orders`, `DELETE /api/orders/{client_order_id}` — limit order actions, with server-side risk checks.
- `GET /api/strategy/signals`, `GET /api/forecast` — research-only signals.
- `POST /api/auth/login`, `POST /api/auth/logout` — single-operator live session.

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q
```

The suite covers paper fills/reservations, order/risk caps, live-mode gates, API routes, and a local CCXT signing smoke test. It does not send requests to ZebPay or place live orders.
