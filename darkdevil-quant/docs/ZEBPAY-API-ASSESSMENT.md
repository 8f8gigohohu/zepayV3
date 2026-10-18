# ZebPay Spot API — private-endpoint assessment and implementation decision

Date: 2026-10-17 · Question asked: *does ZebPay now document spot private API signing and
order endpoints clearly enough to implement them safely?*

## Verdict

| Area | Answer | What the code does now |
|---|---|---|
| Authentication / request signing | **Yes — implementable.** Two independent official sources agree (prose guide + the official spot Node client, which is the only place the canonicalisation is actually written) | `sign_query()` in `backend/app/exchanges/zebpay.py`, cross-checked byte-for-byte against the vendor client in `tests/test_zebpay_private.py` |
| Read-only private endpoints (balances, order list) | **Yes — implementable.** Path, method and parameters agree across all four official sources | `account()` and `open_orders()`; `GET /api/connections/{exchange}/account` exposes the balances read |
| Order placement | **No — not safe to implement.** The sources contradict each other on the request body, and `price` is marked required for every order type | `place_order()` raises `NotImplementedError`; capability is `not_implemented` |
| Order cancellation / details | **No — path disagreement** (`/ex/order?orderId=` vs `/ex/orders/{orderId}`) | `cancel_order()` raises `NotImplementedError` |
| Sandbox / test environment | **None documented** | No trading code exists, so no sandbox is needed yet |

## Evidence gathered

### Official documentation (GitHub `zebpay/zebpay-api-references`, owner-verified)

| Source | What it establishes |
|---|---|
| [Spot overview](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/README.md) | Base URL `https://sapi.zebpay.com`, API v2; private section lists balance + order endpoints |
| [Authentication guide](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/authentication.md) | Two schemes: JWT (`Authorization: Bearer`) or API key (`x-auth-apikey` + `x-auth-signature`); HMAC-SHA256; GET signs the query string with `timestamp`, POST/PUT/DELETE sign the JSON body; GET example uses `timestamp=1234567890` (seconds), POST example uses `Date.now()` (milliseconds). No sorting rule, no URL-encoding rule, no accepted clock window, no nonce |
| [Private endpoints](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/private-endpoints.md) | `GET /api/v2/account/balance` (+ optional `symbol`, `currencies`) returning `data[]` with `currency/total/free/used/...`; `POST /api/v2/ex/orders` body `symbol, side, type, price, amount, quoteOrderAmount, stopLossPrice, clientOrderId, platform`; `GET /api/v2/ex/orders` (symbol required, `status`, `currentPage`, `pageSize`); `GET /api/v2/ex/order?orderId=`; `DELETE /api/v2/ex/order?orderId=`; `GET /api/v2/ex/order/fills?orderId=`; `GET /api/v2/ex/myfee/{symbol}?side=` |
| [Error handling](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/error-handling.md) | Body `{code, message}` / `{statusCode, statusDescription}`; codes `2000` auth failed, `2001` invalid API key, `2002` invalid signature, `2003` expired timestamp, `3000` insufficient balance, `4000` rate limited |
| [Rate limits](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/rate-limits.md) | Public 1200/min, private 600/min; `x-ratelimit-*` headers |
| [Getting started](https://github.com/zebpay/zebpay-api-references/blob/main/spot/api-reference/getting-started.md) | Points at `npm install @zebpay/spot-api-client` — **that package does not exist** (registry returns 404), so the documented client install path is broken |

The repository describes Spot as an active work in progress; the docs are on GitHub rather than
`docs.zebpay.com`, which serves only a general overview.

### Official reference clients

| Client | Finding |
|---|---|
| [Spot Node client — `utils/auth.js`](https://github.com/zebpay/zebpay-api-references/blob/main/spot/clients/rest-http/node/utils/auth.js) | **The canonical implementation, and the source used here.** GET: `timestamp = Date.now()` appended last, query string built as `encodeURIComponent(k)=encodeURIComponent(v)` joined with `&`, signature `HMAC-SHA256(secret, string).hex`, headers `x-auth-apikey` / `x-auth-signature`. POST/PUT/DELETE: same HMAC over `JSON.stringify(body)` with `timestamp` in the body |
| Spot Node client — `utils/config.js` | `baseUrl` is `https://www.zebstage.com` — a **staging** host, not the documented `sapi.zebpay.com`. The published client is not pointed at production |
| Spot Node client — `client.js` | Signs GET/DELETE over the query string (the auth guide says DELETE signs the body) and leaves debug `console.log(headers)` calls in the request path |
| [Spot Python client](https://github.com/zebpay/zebpay-api-references/blob/main/spot/clients/rest-http/python/zebpay_spot_client.py) | **Unsafe — do not use.** It sends `X-API-KEY` and `X-API-SECRET` as plain headers and never signs anything, i.e. it transmits the API secret with every request. Its package (`pip install zebpay-spot-client`) also returns 404 on PyPI. Live probing showed those headers are not recognised (server falls back to JWT parsing) |

### Live probes from this deployment (no credentials used)

| Probe | Result |
|---|---|
| `GET /api/v2/account/balance` (no auth) | `401 {"data":null,"statusCode":401,"statusDescription":"token contains an invalid number of segments"}` — endpoint exists, falls back to JWT |
| `GET /api/v2/ex/orders?symbol=BTC-INR` (no auth) | `401`, same shape — endpoint exists |
| Same call with `x-auth-apikey: dummy` + `x-auth-signature: <hmac>` | `401 {"statusCode":401,"statusDescription":"invalid api key"}` — **proves the documented header names are the ones the server reads**, and that the API-key path is taken when they are present |
| Same call with `X-API-KEY` / `X-API-SECRET` (the official Python client's headers) | `401 "token contains an invalid number of segments"` — those headers are ignored |
| Same call with `x-auth-apikey`/`x-auth-signature` but **no `timestamp` in the query** (a `timestamp` HTTP header alone does not help) | `400 "Missing timestamp."` — proves the timestamp must be a **query parameter**, as the official client does |
| Request built by this repo's `sign_query()` with a dummy key | reaches the same `401 "invalid api key"` branch, i.e. the query string, headers and signature shape are accepted |
| `GET /api/v2/time` (documented) | `404` — the documented server-time endpoint does not exist, so clock-skew cannot be measured from the API |

## Bug found by the end-to-end probe (fixed)

The first live call through the API returned `400 "Missing timestamp."` even though the adapter
signed a query string containing `timestamp`. The adapter was correct; the shared helper was not:
`httpx` **replaces** a URL's query string whenever a `params` argument is passed — including an empty
dict — so `http.get(url, params={})` silently sent `/api/v2/account/balance` with no query at all.

`backend/app/exchanges/http.py` now only passes `params` when non-empty, and
`backend/tests/test_http_helper.py` pins the behaviour with a local echo server (the exact signed
path that arrives, plus normal parameter handling). This would have broken every signed GET, for
ZebPay and for any future adapter that pre-builds its own query.

After the fix, the same request reaches ZebPay's API-key branch and answers `401 "invalid api key"` —
the strongest verification possible without real credentials.

## What was implemented (read-only, evidence-based)

`backend/app/exchanges/zebpay.py`:

- `encode_component()` / `build_query()` / `sign_query()` — the vendor client's canonicalisation,
  including the four characters (`!*'()`) where JavaScript's `encodeURIComponent` and Python's
  `quote()` differ.
- The signed query string is **sent verbatim** (no dict re-encoding by the HTTP layer), so the bytes
  the server hashes are exactly the bytes signed.
- Millisecond timestamps by default (per the official client). Because the docs' GET example shows
  seconds, the adapter retries **exactly once** in seconds — and only when the server answers with the
  documented `2003 expired timestamp` code. `2002 invalid signature` is never retried.
- `account()` (balances) and `open_orders()` (order list) are read-only; both report
  `verified_docs`, never `verified_live`, because no real account has been read from here.
- `GET /api/connections/{exchange}/account` exposes the balances snapshot to an authenticated user.
  `501` for a genuinely unimplemented capability, `502` with the upstream reason for a failed read.
- `place_order()` / `cancel_order()` raise `NotImplementedError` carrying the exact documentation
  conflict, and the capability matrix reports `not_implemented`.

**Never** transmitted: the secret is used only as an HMAC key. It is not placed in the URL, headers,
logs, audit details or API responses.

## Why order placement stays blocked

1. **Request body contradicts itself.** Private-endpoints page: `amount`, `quoteOrderAmount`,
   `stopLossPrice`. Overview page, both official clients and the getting-started example:
   `quantity`, `quoteOrderQty`, `stopPrice`. If `quantity` were silently ignored, a `MARKET` buy
   could execute at a different size than intended.
2. **`price` is marked required for all order types**, including `MARKET`, and the getting-started
   example places a `MARKET` order with no price. One of the two is wrong.
3. **Order-detail/cancel paths contradict.** `GET|DELETE /api/v2/ex/order?orderId=` on the detailed
   page versus `GET|DELETE /api/v2/ex/orders/{orderId}` in the overview and both clients.
4. **No accepted clock window, no sorting rule, no nonce** documented for signing; `GET /api/v2/time`
   is 404, so skew cannot be measured before signing.
5. **No sandbox**, and no credentials are available in this environment to observe the real server's
   behaviour for `2002`/`2003`.

A wrong field name on a live order is an uninsured financial action, so it is refused by construction
rather than guessed. This is the same policy already applied to Binance order placement.

## To unblock order placement

Ask ZebPay support (or the account manager) to confirm, in writing:

1. The authoritative `POST /api/v2/ex/orders` body for `LIMIT` and `MARKET`: `quantity` vs `amount`,
   `quoteOrderQty` vs `quoteOrderAmount`, `stopPrice` vs `stopLossPrice`, and whether `price` is
   truly required for `MARKET`.
2. The authoritative order-detail/cancel paths.
3. The signing timestamp unit and the accepted window, plus whether `timestamp` must be in the query
   or is header-based.
4. Whether a sandbox/UAT base URL exists.

Then verify, in order: (a) read-only key → balances (`200`, already implemented); (b) open-orders
list; (c) a cancel of a non-existent order id (harmless `4xx`); (d) finally a minimum-size order on a
paper or sandbox account. Only after that does `place_order` earn `verified_live`, and the risk engine
still requires the three independent gates to be open.

## Reproduce the checks

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_zebpay_private.py   # 10 signing/parsing/refusal tests
.venv/bin/python -m pytest -q tests/test_http_helper.py      # 2 query-preservation tests
.venv/bin/python -m pytest -q                                # 41 passed, 2 skipped
```

The signing vectors in `tests/test_zebpay_private.py` were generated by running the official client's
algorithm in Node with a fixed clock, then pasted in — they are a cross-implementation check, not a
self-comparison.
