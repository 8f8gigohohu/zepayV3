import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport } from '../src/core/http.js';
import {
  ApiError,
  AuthError,
  RateLimitError,
  TransportError,
  ValidationError,
} from '../src/core/errors.js';

const BASE = 'https://futuresbe.zebpay.com';
const SECRET = 'test-secret-key';

/**
 * Recording fetch stub. Captures every request so tests can assert that the
 * bytes actually transmitted match the bytes that were signed.
 */
function makeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const spec = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: new Map(Object.entries(spec.headers ?? {})),
      text: async () =>
        spec.body === undefined
          ? ''
          : typeof spec.body === 'string'
            ? spec.body
            : JSON.stringify(spec.body),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ok = (data) => ({
  status: 200,
  body: { statusDescription: 'OK', data, statusCode: 200, customMessage: ['OK'] },
});

test('public GET sends no auth headers and unwraps the data envelope', async () => {
  const f = makeFetch([ok({ symbol: 'BTCINR', bids: [[7478615, 4.04]] })]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  const data = await t.request({
    method: 'GET',
    path: '/api/v1/market/orderBook',
    query: { symbol: 'BTCINR' },
  });

  assert.equal(data.symbol, 'BTCINR');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${BASE}/api/v1/market/orderBook?symbol=BTCINR`);
  const headers = f.calls[0].headers;
  assert.equal(headers['x-auth-apikey'], undefined);
  assert.equal(headers['x-auth-signature'], undefined);
  assert.equal(headers.Authorization, undefined);
});

test('apiKey GET transmits exactly the signed query string', async () => {
  const f = makeFetch([ok({})]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'GET',
    path: '/api/v1/wallet/balance',
    auth: { type: 'apiKey', apiKey: 'AK', secret: SECRET },
  });

  const url = new URL(f.calls[0].url);
  const query = url.search.slice(1);
  // The transport must not rebuild or re-encode the query after signing it.
  assert.match(query, /^timestamp=\d+$/);
  assert.equal(f.calls[0].headers['x-auth-apikey'], 'AK');
  assert.match(f.calls[0].headers['x-auth-signature'], /^[0-9a-f]{64}$/);
});

test('apiKey GET with params appends timestamp after the caller params', async () => {
  const f = makeFetch([ok({})]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'GET',
    path: '/api/v1/trade/history',
    query: { symbol: 'BTCINR', limit: 10 },
    auth: { type: 'apiKey', apiKey: 'AK', secret: SECRET },
  });

  const query = new URL(f.calls[0].url).search.slice(1);
  assert.match(query, /^symbol=BTCINR&limit=10&timestamp=\d+$/);
});

test('apiKey POST transmits the exact compact body it signed', async () => {
  const f = makeFetch([{ status: 201, body: { data: { clientOrderId: 'x' }, statusCode: 201 } }]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'POST',
    path: '/api/v1/trade/order',
    body: { symbol: 'BTCINR', side: 'BUY', type: 'MARKET', amount: 0.001 },
    auth: { type: 'apiKey', apiKey: 'AK', secret: SECRET },
  });

  const sent = f.calls[0].body;
  assert.equal(typeof sent, 'string', 'body must be sent as the signed string, not re-serialized');
  assert.ok(!/\s/.test(sent), 'compact JSON');
  const parsed = JSON.parse(sent);
  assert.equal(parsed.symbol, 'BTCINR');
  assert.ok(Number.isSafeInteger(parsed.timestamp), 'timestamp injected at root');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/json');
});

test('DELETE with a body is signed as a body request, not a query', async () => {
  const f = makeFetch([ok({})]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'DELETE',
    path: '/api/v1/trade/order',
    body: { clientOrderId: 'abc' },
    auth: { type: 'apiKey', apiKey: 'AK', secret: SECRET },
  });

  assert.equal(new URL(f.calls[0].url).search, '', 'no query string on a body-signed DELETE');
  assert.deepEqual(JSON.parse(f.calls[0].body).clientOrderId, 'abc');
});

test('JWT auth sends a Bearer header and no HMAC headers', async () => {
  const f = makeFetch([ok({})]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'GET',
    path: '/api/v1/wallet/balance',
    auth: { type: 'jwt', token: 'jwt-token' },
  });

  assert.equal(f.calls[0].headers.Authorization, 'Bearer jwt-token');
  assert.equal(f.calls[0].headers['x-auth-signature'], undefined);
});

test('subaccountId is sent as a header', async () => {
  const f = makeFetch([ok({})]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });

  await t.request({
    method: 'GET',
    path: '/api/v1/trade/positions',
    auth: { type: 'jwt', token: 'j' },
    subaccountId: '456',
  });

  assert.equal(f.calls[0].headers.subaccountid, '456');
});

test('429 raises RateLimitError and is retried with backoff', async () => {
  const f = makeFetch([
    {
      status: 429,
      body: { statusDescription: 'Please note your API request has exceeded daily limits.', data: {}, statusCode: 429 },
    },
    ok({ recovered: true }),
  ]);
  const sleeps = [];
  const t = new HttpTransport({
    baseUrl: BASE,
    fetch: f,
    maxRetries: 3,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0, // deterministic jitter
  });

  const data = await t.request({ method: 'GET', path: '/api/v1/system/time' });

  assert.equal(data.recovered, true, 'should succeed after the retry');
  assert.equal(f.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0, 'must wait before retrying');
});

test('backoff grows exponentially and is capped at 10s', () => {
  const t = new HttpTransport({ baseUrl: BASE, fetch: async () => {}, random: () => 1 });
  const b0 = t.backoffMs(0);
  const b1 = t.backoffMs(1);
  const b2 = t.backoffMs(2);
  const b20 = t.backoffMs(20);
  assert.ok(b1 > b0 && b2 > b1, 'backoff must increase');
  assert.ok(b20 <= 10_000, `expected cap at 10s, got ${b20}`);
});

test('400 is not retried — a bad signature will not fix itself', async () => {
  const f = makeFetch([{ status: 400, body: { statusDescription: 'Invalid signature', data: {} } }]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f, maxRetries: 5 });

  await assert.rejects(
    () => t.request({ method: 'GET', path: '/api/v1/wallet/balance' }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /Invalid signature/);
      return true;
    },
  );
  assert.equal(f.calls.length, 1, 'no retries for a client error');
});

test('403 maps to AuthError and surfaces the scope hint from customMessage', async () => {
  const f = makeFetch([
    { status: 403, body: { data: {}, customMessage: ['You do not have the required scope'] } },
  ]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f, maxRetries: 3 });

  await assert.rejects(
    () => t.request({ method: 'POST', path: '/api/v1/trade/order', body: {} }),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.status, 403);
      assert.match(err.message, /required scope/);
      assert.equal(err.path, '/api/v1/trade/order');
      return true;
    },
  );
  assert.equal(f.calls.length, 1, 'auth errors are never retried');
});

test('exhausted 5xx retries throw the last ApiError', async () => {
  const f = makeFetch([{ status: 503, body: { data: {}, statusDescription: 'unavailable' } }]);
  const sleeps = [];
  const t = new HttpTransport({
    baseUrl: BASE,
    fetch: f,
    maxRetries: 2,
    sleep: async (ms) => void sleeps.push(ms),
  });

  await assert.rejects(
    () => t.request({ method: 'GET', path: '/api/v1/system/status' }),
    (err) => err instanceof ApiError && err.status === 503,
  );
  assert.equal(f.calls.length, 3, 'initial attempt plus 2 retries');
  assert.equal(sleeps.length, 2);
});

test('network failure becomes TransportError and is retried', async () => {
  let n = 0;
  const f = async () => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ data: { ok: 1 } }),
    };
  };
  const t = new HttpTransport({ baseUrl: BASE, fetch: f, sleep: async () => {} });

  const data = await t.request({ method: 'GET', path: '/api/v1/system/time' });
  assert.equal(data.ok, 1);
  assert.equal(n, 2);
});

test('a hanging request aborts after timeoutMs', async () => {
  const f = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const t = new HttpTransport({ baseUrl: BASE, fetch: f, timeoutMs: 20, maxRetries: 0 });

  await assert.rejects(
    () => t.request({ method: 'GET', path: '/api/v1/system/time' }),
    (err) => {
      assert.ok(err instanceof TransportError);
      assert.match(err.message, /timed out after 20ms/);
      return true;
    },
  );
});

test('a non-envelope body is returned as parsed JSON', async () => {
  const f = makeFetch([{ status: 200, body: { somethingElse: true } }]);
  const t = new HttpTransport({ baseUrl: BASE, fetch: f });
  const data = await t.request({ method: 'GET', path: '/api/v1/whatever' });
  assert.deepEqual(data, { somethingElse: true });
});

test('baseUrl requires a value and trailing slashes are stripped', () => {
  assert.throws(() => new HttpTransport({ baseUrl: '' }), ValidationError);
  const t = new HttpTransport({ baseUrl: `${BASE}///`, fetch: makeFetch([ok({})]) });
  assert.equal(t.baseUrl, BASE);
});

test('onRequest hook observes every attempt', async () => {
  const seen = [];
  const f = makeFetch([{ status: 500, body: { data: {} } }, ok({})]);
  const t = new HttpTransport({
    baseUrl: BASE,
    fetch: f,
    sleep: async () => {},
    onRequest: (r) => seen.push(r),
  });

  await t.request({ method: 'GET', path: '/api/v1/system/time' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].auth, 'none');
});
