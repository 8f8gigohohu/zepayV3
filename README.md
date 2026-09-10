# zepayV3

ZebPay **Futures** client SDK, dry-run strategy engine, live BTC-INR dashboard, and an
AI decision stack that evaluates every symbol and decides **LONG / SHORT / NO_TRADE**.

Built against the official ZebPay Futures REST API (`https://futuresbe.zebpay.com`, `/api/v1`) and
cross-checked against [`zebpay/zebpay-api-references`](https://github.com/zebpay/zebpay-api-references).

- **Node.js 20+**, ESM, no build step
- **One runtime dependency** (`socket.io-client`, and only for the private WebSocket)
- **360 tests**, `node:test`, no test framework to install

```
npm install
npm test            # 360 tests
npm run dashboard   # live BTC-INR dashboard
npm run bot         # strategy engine, dry-run by default
npm run check:live  # smoke-test the real API from a networked machine
```

**Read this before you trade.** `NO_TRADE` is the expected answer most of the time and is a real
outcome, not a failure. Nothing here is a profit guarantee, and the model score is a ranking
signal — not a probability of profit. Live trading is off unless you set `ZEBPAY_ALLOW_LIVE=true`
**and** pass `--live`; the risk and permission engines outrank the model and can always refuse it.

---

## Quick start

```js
import { ZebpayFuturesClient, OrderGateway, StrategyEngine, createEmaCrossStrategy } from 'zepayv3';

// Public market data — no credentials
const client = new ZebpayFuturesClient();
const book = await client.getOrderBook('BTC-INR');   // accepts 'BTC-INR' or 'BTCINR'
console.log(book.bids[0], book.asks[0]);

// Authenticated reads — needs fetch:details scope
const auth = new ZebpayFuturesClient({ apiKey: process.env.ZEBPAY_API_KEY, apiSecret: process.env.ZEBPAY_API_SECRET });
const balance = await auth.getWalletBalance();

// Strategy in dry-run: validated and priced, never transmitted
const gateway = new OrderGateway({ client: auth, priceSource: () => book.bids[0][0] });
const engine = new StrategyEngine({
  client: auth,
  gateway,
  strategy: createEmaCrossStrategy({ fastPeriod: 9, slowPeriod: 21 }),
  symbol: 'BTCINR',
});
await engine.start();
```

Copy `.env.example` to `.env` and fill in your keys. Environment variables always win over the file.

---

## Dashboard

`npm run dashboard` serves a multi-page dashboard. Each function has its own page, reachable from
the nav bar or by hash:

| Page | URL | What it shows |
| :-- | :-- | :-- |
| **Overview** | `#/overview` | Data mode, price, bot state, order mode, AI verdict, safety summary |
| **Live Market** | `#/market` | Price, 24h change, candlestick chart, order book, recent trades, connection state |
| **Bot Status** | `#/bot` | Running/stopped, strategy, order mode, warm-up, fill count, errors, and *why* it is idle |
| **AI Decisions** | `#/ai` | Model calls, vetoes, permissions, audit trail, kill switch |
| **Setup** | `#/setup` | Where `.env` goes, every variable, key setup, subaccount, endpoints, commands |
| **Fix Report** | `#/report` | Problems, root causes, exact fixes and expected results — copyable as plain text |

### LIVE vs DEMO

The banner and the mode badge always say which one you are looking at:

- **LIVE** — real data from `https://futuresbe.zebpay.com`
- **DEMO** — synthetic prices generated locally. Never presented as real, and never usable for
  trading decisions.

### Startup does not block on the network

The HTTP port binds **first**. Candle history, bot warm-up, feed polling and clock-skew
measurement all load afterwards, in the background, and report into the UI as they land. The only
bounded wait is the initial LIVE-vs-DEMO probe, capped by `ZEBPAY_STARTUP_TIMEOUT_MS` (default 6s),
so a hung upstream degrades to demo instead of leaving you staring at a blank tab.

```
  dashboard  http://localhost:4173      ← page is already reachable here
  data mode  DEMO (synthetic)
  orders     dry-run

  ✓ candle history loaded (181 candles)
  [bot] warm-up complete — 181 candles loaded
  ✓ bot started (ema-cross(5,12), dry-run)
```

### Secrets

No secret reaches the browser, the Fix Report, or the logs. The Setup page shows a *masked
fingerprint* so you can confirm which key is loaded:

- `ZEBPAY_API_KEY` → `ak_l…6666` — a key is an identifier, so its tail is harmless
- `ZEBPAY_API_SECRET` → `sk_l… (40 chars, hidden)` — the credential gets a prefix only

`.env` is gitignored; `.env.example` is committed. There is no browser field for credentials and no
HTTP route that can place an order.

---

## What is in here

| Path | Purpose |
| :-- | :-- |
| `src/core/sign.js` | HMAC-SHA256 request signing |
| `src/core/http.js` | Transport: retries, backoff, envelope unwrap, typed errors |
| `src/core/symbols.js` | `BTC-INR` ↔ `BTCINR`, timeframes, kline parsing |
| `src/core/errors.js` | Error hierarchy |
| `src/client/ZebpayFutures.js` | Every documented REST endpoint |
| `src/ws/PrivateStream.js` | Private Socket.IO stream (`/auth-stream`) |
| `src/strategy/OrderGateway.js` | Dry-run/live order routing, position bookkeeping |
| `src/strategy/engine.js` | Polling strategy loop |
| `src/strategy/indicators.js` | SMA, EMA, RSI, ATR, Donchian |
| `src/strategy/strategies/emaCross.js` | Reference strategy |
| `src/server/` | Dashboard: HTTP + SSE, canvas UI, pages |
| `src/server/setup.js` | Setup-page introspection; secrets masked server-side |
| `src/server/report.js` | Fix Report generation from live runtime state |
| `bin/zepay.js` | CLI |
| **AI stack** | |
| `src/ai/features.js` | Candle/book factors, regime classification |
| `src/ai/engine.js` | LONG / SHORT / NO_TRADE decision with reasons |
| `src/costs/engine.js` | Fees, TDS, slippage, funding, liquidation, sizing |
| `src/risk/engine.js` | Pre-trade risk checks — final authority |
| `src/risk/killswitch.js` | Manual stop + automatic breakers |
| `src/permissions/engine.js` | Capability gates; withdrawals forbidden |
| `src/audit/log.js` | Append-only JSONL audit trail with secret redaction |
| `src/scanner/scanner.js` | Universe discovery and ranking |
| `src/autonomous/pipeline.js` | The gate sequence (evaluation + execution) |
| `src/autonomous/runner.js` | Scan scheduling and universe refresh |
| `src/commands/{ai,doctor,ai-factory}.js` | CLI entry points and wiring |

### CLI

```bash
node bin/zepay.js ticker BTC-INR          # 24h stats
node bin/zepay.js book BTC-INR            # order book
node bin/zepay.js klines BTC-INR --tf=1h --limit=40
node bin/zepay.js markets                 # symbols, precision, leverage caps
node bin/zepay.js time                    # server time + your clock skew
node bin/zepay.js balance                 # private, needs credentials
node bin/zepay.js dashboard --port=4173
node bin/zepay.js run --tf=1m --amount=0.001

node bin/zepay.js doctor                  # environment + readiness check
node bin/zepay.js ai --cycles=3           # scan, decide, explain (never trades)
node bin/zepay.js ai --autonomous         # ...and let it act, still dry-run
node bin/zepay.js dashboard --ai          # AI panel in the dashboard, evaluate-only
```

---

## Authentication

Two methods are supported, exactly as documented.

**API key + secret** — HMAC-SHA256, lowercase hex:

| Request type | What is signed |
| :-- | :-- |
| `GET` | the query string **exactly as transmitted**, with `timestamp` appended |
| `POST` / `PUT` / `PATCH` / `DELETE`-with-body | the **compact** JSON body, with `timestamp` at the root |

Headers: `x-auth-apikey`, `x-auth-signature`. Subaccount requests add a `subaccountid` header.

The transport returns the signature *and* the payload it signed, so it is not possible to sign one
string and send another — the most common cause of `400 Invalid signature`.

**JWT** — `Authorization: Bearer <token>`, no scope checks.

### Scopes

| Scope | Grants |
| :-- | :-- |
| `fetch:details` | Private reads **and** the private WebSocket |
| `futures:trading` | All REST writes, plus the reads above |

A key doing full REST trading *and* private WebSocket events needs **both**. Note that
`futures:trading` alone is rejected by the private WebSocket.

---

## AI autonomous trading

`zepay ai` scans the universe and, for each symbol, decides **LONG**, **SHORT** or **NO_TRADE**.
Every decision carries a reason, and non-trades carry several.

```bash
node bin/zepay.js doctor                 # check connectivity, clock, fees, safety config
node bin/zepay.js ai --cycles=3          # decide and explain; never places an order
node bin/zepay.js ai --autonomous        # allow it to act (still dry-run)
node bin/zepay.js dashboard --ai         # AI panel alongside the live chart
```

### The gate sequence

A symbol passes through every gate in order. Each one can stop it, and the stage that stopped it is
recorded:

```
kill switch → market data → features/regime → AI decision → geometry
           → sizing → cost projection → RISK ENGINE → PERMISSIONS → order gateway
```

The **risk engine and the permission engine outrank the model.** A trade the AI is 90% confident in
is still refused if net edge after costs is too thin, the book is too thin, exposure is too high, or
the operator has not enabled autonomous entries. The dashboard shows this distinction explicitly: a
row reads `LONG vetoed` when the model wanted to trade and something upstream said no.

### What "no trade" looks like

```
  BTCINR        61.8%  UNCERTAIN        NO_TRADE      regime is UNCERTAIN (trend -0.31 ambiguous)
```

with the full reason list on `/api/ai/trace?symbol=BTCINR`:

```json
{ "stage": "ai",
  "reasons": ["regime is UNCERTAIN (trend -0.31 ambiguous)",
              "uncertainty score 62% outweighs the directional score",
              "data quality: regime UNCERTAIN",
              "data quality: volume drying up"] }
```

The model score is deliberately **capped below 1.0** — a baseline uncertainty mass is always
present. Without it a clean setup scores exactly 1.0, which is both dishonest and useless, because
1.0 clears any confidence threshold you might set.

### Costs and the numbers it reports

`projectTrade()` computes the net figure, never the gross one: fees on **entry and exit**, half the
spread, order-book impact from walking the book, funding, and TDS. It also reports a break-even move
and a liquidation price.

Two honest gaps:

- **`tdsRatePct` defaults to 0.** Tax treatment is not inferred. Set it explicitly if you want it
  modelled.
- **A position that cannot be liquidated reports `liquidationPrice: null`**, not zero. At or below
  ~1x leverage the isolated-margin formula has no positive solution, and a price of zero would be a
  lie.

### Nothing is invented

- Account equity is read from `wallet/balance`. If the shape is unrecognised, equity is **0** and
  the risk engine blocks the trade — it never guesses a plausible balance. `readEquity()` reports
  which field it used.
- Fees come from `exchange/tradefee`, not a constant.
- A missing order book is recorded as an unknown factor, never replaced with a synthetic one.
- `--paperEquity=N` is the one operator-supplied number, so sizing can be exercised without live
  credentials. It is **refused outright** when combined with `--live`, and is always labelled
  `paper (operator-supplied)`.

### Dashboard endpoints

| Route | Purpose |
| :-- | :-- |
| `GET /api/ai/status` | Runner, account, order mode, kill switch |
| `GET /api/ai/scan` | Ranked results of the last cycle |
| `GET /api/ai/trace?symbol=` | Full trace for one symbol, no execution |
| `GET /api/ai/health` | `READY (LIVE)` / `PAPER ONLY` / `NOT TRADING`, with reasons |
| `POST /api/ai/cycle` | Run one scan now |
| `GET/POST /api/ai/permissions` | Read or toggle capabilities |
| `POST /api/ai/killswitch` | `engage` / `resume` / `resetBreaker` — a reason is mandatory |
| `GET /api/ai/audit` | Audit tail + per-type summary |

There is deliberately **no endpoint that places an order directly**. The only path to an order runs
through the pipeline's gate sequence.

---

## Safety: the live-trading kill switch

The engine runs in **dry-run** unless *two independent* conditions both hold:

1. `ZEBPAY_ALLOW_LIVE=true` in the environment
2. `--live` on the command line

Either one missing and `OrderGateway` cannot transmit an order — it throws
`LiveTradingBlockedError`. A stray env var in a container is therefore not enough to move real money.

Two further guards:

- If the market feed is not live, live trading is disabled even when both switches are set. You
  cannot trade on prices that did not come from the exchange.
- Dry-run fills price against the **live last price** and apply the taker fee, so simulated results
  are not flattered by filling at the signal price.

---

## Endpoints

**Public** (no auth): `system/time`, `system/status`, `market/markets`, `market/orderBook`,
`market/ticker24Hr`, `market/marketInfo`, `market/aggTrade`, `market/klines`,
`exchange/tradefee`, `exchange/tradefees`, `exchange/exchangeInfo`, `exchange/pairs`.

**Private** (auth required): `wallet/balance`, `trade/order` (`POST`/`GET`/`PATCH`/`DELETE`),
`trade/order/all`, `trade/order/addTPSL`, `trade/order/open-orders`, `trade/order/history`,
`trade/positions`, `trade/position/close`, `trade/addMargin`, `trade/reduceMargin`,
`trade/userLeverage`, `trade/userLeverages`, `trade/update/userLeverage`, `trade/history`,
`trade/transaction/history`.

### API quirks handled here

- `market/klines` is a **POST** whose body uses `timeframe` and `since` — not `interval`,
  `startTime` or `endTime`. Unknown body fields are **stripped, not rejected**, so a typo silently
  returns 1m candles. `assertTimeframe()` turns that into a local error.
- There is no `endTime` parameter, so deeper history requires paging backwards with
  `getKlinesHistory()`, which de-duplicates and re-sorts.
- `cancelOrder` sends `clientOrderId` in the **body** of a `DELETE`, which must be signed.
- On the order/trade/transaction history endpoints, `timestamp` doubles as the pagination cursor and
  must stay inside the auth timestamp window — page far back with JWT, not an API key.
- The 429 response has **no `Retry-After`**, so backoff is exponential with full jitter.
- The private stream is **Socket.IO, not raw WebSocket**, at `https://sp-futuresws.zebpay.com`
  namespace `/auth-stream`. Wait for `auth.ok`; `auth.error` means the service will disconnect.
  The signed payload is only `{"timestamp":<ms>}` (plus `subaccountId` when applicable).

---

## Writing a strategy

```js
const strategy = {
  name: 'my-strategy',
  onCandles({ candles, ctx }) {
    // ctx: { symbol, timeframe, positionQty, orderAmount, lastPrice, candles }
    return { action: 'BUY', amount: 0.001, reason: 'signal fired' };
    // action: 'BUY' | 'SELL' | 'CLOSE' | 'HOLD'
  },
};
```

The engine only ever hands the strategy **closed** candles. The newest row from the klines endpoint
is still forming, so acting on it would repaint — a signal computed mid-candle can vanish by candle
close. `dropFormingCandle()` drops it, and the cursor advances so the same candle is never acted on
twice.

---

## Tests

```
npm test
```

Covers signing (against **OpenSSL-generated known-answer vectors**, so a regression cannot silently
agree with itself), transport retry/backoff/error mapping, every endpoint's path and body, order
validation, position bookkeeping including flip-through-zero, indicator values, engine cadence, the
WebSocket handshake, and the HTTP server including the SSE stream.

The AI stack adds a further ~150 tests: feature extraction and regime classification, decision
scoring including the sub-1.0 certainty cap, cost/TDS/liquidation projection, risk sizing and every
risk check, the permission gates (including that `withdrawal` cannot be granted by any route), audit
redaction, kill-switch behaviour mid-run, exposure accumulating across cycles, and every dashboard
AI endpoint including the refusal paths.

---

## Caveats

- **Not verified against the live API from this environment.** Every `*.zebpay.com` host is
  unreachable from the sandbox (`SSL_ERROR_SYSCALL`), so the suite runs against stub transports and
  recorded fixtures. Run `npm run check:live` from a networked machine before trusting it; it
  validates the public response shapes and exits non-zero on drift.
- The futures **market** WebSocket host in the docs (`futuresws.zebpay.com`) differs from the
  **private** one (`sp-futuresws.zebpay.com`). This project polls REST for market data and uses
  Socket.IO only for the private stream, sidestepping that inconsistency.
- Spot (`https://sapi.zebpay.com`, v2) is not covered — this is Futures only.
- Floating-point quantity tracking is quantized to 12 decimals to stop drift accumulating across
  fills. For money you care about, reconcile against `GET /trade/positions` rather than trusting the
  simulated book.

## License

MIT
