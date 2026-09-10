# zepayV3

ZebPay **Futures** client SDK, dry-run strategy engine and live BTC-INR dashboard.

Built against the official ZebPay Futures REST API (`https://futuresbe.zebpay.com`, `/api/v1`) and
cross-checked against [`zebpay/zebpay-api-references`](https://github.com/zebpay/zebpay-api-references).

- **Node.js 20+**, ESM, no build step
- **One runtime dependency** (`socket.io-client`, and only for the private WebSocket)
- **179 tests**, `node:test`, no test framework to install

```
npm install
npm test            # 179 tests
npm run dashboard   # live BTC-INR dashboard
npm run bot         # strategy engine, dry-run by default
npm run check:live  # smoke-test the real API from a networked machine
```

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
| `src/server/` | Dashboard: HTTP + SSE, canvas UI |
| `bin/zepay.js` | CLI |

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
