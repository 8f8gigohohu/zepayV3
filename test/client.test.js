import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZebpayFuturesClient, assertOrderShape } from '../src/client/ZebpayFutures.js';
import { ValidationError } from '../src/core/errors.js';

/** Transport stub that records calls and returns canned data. */
function stubTransport(data = {}, { failPrivate = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      if (req.auth.type !== 'none' && failPrivate) {
        throw new ValidationError('no credentials');
      }
      const key = `${req.method} ${req.path}`;
      return key in data ? data[key] : {};
    },
  };
}

const publicClient = (data) =>
  new ZebpayFuturesClient({ transport: stubTransport(data) });

const privateClient = (data) =>
  new ZebpayFuturesClient({ apiKey: 'AK', apiSecret: 'SK', transport: stubTransport(data) });

/* ── Auth plumbing ───────────────────────────────────────────────────────── */

test('isAuthenticated reflects credential presence', () => {
  assert.equal(new ZebpayFuturesClient().isAuthenticated, false);
  assert.equal(new ZebpayFuturesClient({ apiKey: 'a' }).isAuthenticated, false, 'key without secret');
  assert.equal(new ZebpayFuturesClient({ apiKey: 'a', apiSecret: 'b' }).isAuthenticated, true);
  assert.equal(new ZebpayFuturesClient({ jwt: 'j' }).isAuthenticated, true);
});

test('private endpoints refuse to run without credentials', async () => {
  const client = publicClient();
  await assert.rejects(() => client.getWalletBalance(), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /requires authentication/);
    assert.match(err.message, /fetch:details/);
    return true;
  });
});

test('private endpoints use apiKey auth and forward the subaccount id', async () => {
  const t = stubTransport({ 'GET /api/v1/wallet/balance': { free: 1 } });
  const client = new ZebpayFuturesClient({
    apiKey: 'AK',
    apiSecret: 'SK',
    subaccountId: '456',
    transport: t,
  });

  await client.getWalletBalance();
  assert.deepEqual(t.calls[0].auth, { type: 'apiKey', apiKey: 'AK', secret: 'SK' });
  assert.equal(t.calls[0].subaccountId, '456');
});

test('JWT takes effect when no API key pair is supplied', async () => {
  const t = stubTransport({ 'GET /api/v1/trade/positions': [] });
  const client = new ZebpayFuturesClient({ jwt: 'tok', transport: t });

  await client.getPositions();
  assert.deepEqual(t.calls[0].auth, { type: 'jwt', token: 'tok' });
});

/* ── Public endpoints ────────────────────────────────────────────────────── */

test('public endpoints hit the documented paths without auth', async () => {
  const t = stubTransport({});
  const client = new ZebpayFuturesClient({ transport: t });

  await client.getServerTime();
  await client.getSystemStatus();
  await client.getMarkets();
  await client.getMarketInfo();
  await client.getTradeFees();
  await client.getExchangeInfo();
  await client.getPairs();

  assert.deepEqual(
    t.calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /api/v1/system/time',
      'GET /api/v1/system/status',
      'GET /api/v1/market/markets',
      'GET /api/v1/market/marketInfo',
      'GET /api/v1/exchange/tradefees',
      'GET /api/v1/exchange/exchangeInfo',
      'GET /api/v1/exchange/pairs',
    ],
  );
  assert.ok(t.calls.every((c) => c.auth.type === 'none'), 'public routes must not be signed');
});

test('getOrderBook normalizes the UI symbol form and queries the API form', async () => {
  const t = stubTransport({ 'GET /api/v1/market/orderBook': { symbol: 'BTCINR', bids: [] } });
  const client = new ZebpayFuturesClient({ transport: t });

  await client.getOrderBook('BTC-INR');
  assert.equal(t.calls[0].query.symbol, 'BTCINR');
});

test('symbol normalization accepts dash, underscore, space and lowercase', async () => {
  const t = stubTransport({});
  const client = new ZebpayFuturesClient({ transport: t });

  for (const input of ['BTC-INR', 'btcinr', 'btc_inr', ' btc inr ']) {
    await client.getTicker24Hr(input);
  }
  assert.deepEqual(
    t.calls.map((c) => c.query.symbol),
    ['BTCINR', 'BTCINR', 'BTCINR', 'BTCINR'],
  );
});

test('getKlines is a POST whose body uses timeframe/since, not interval/startTime', async () => {
  const t = stubTransport({ 'POST /api/v1/market/klines': [] });
  const client = new ZebpayFuturesClient({ transport: t });

  await client.getKlines({ symbol: 'BTC-INR', timeframe: '15m', since: 1712345678000, limit: 50 });

  const call = t.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/v1/market/klines');
  assert.equal(call.body.symbol, 'BTCINR');
  assert.equal(call.body.timeframe, '15m');
  assert.equal(call.body.since, 1712345678000);
  assert.equal(call.body.limit, 50);
  assert.equal(call.body.interval, undefined);
  assert.equal(call.body.startTime, undefined);
  assert.equal(call.query.priceType, 'LTP');
});

test('getKlines rejects an unsupported timeframe before sending', async () => {
  const t = stubTransport({});
  const client = new ZebpayFuturesClient({ transport: t });

  // The endpoint silently strips unknown fields, so a typo would otherwise
  // return 1m candles and look like success.
  await assert.rejects(() => client.getKlines({ symbol: 'BTCINR', timeframe: '2m' }), ValidationError);
  assert.equal(t.calls.length, 0);
});

test('getKlines converts positional rows into typed candles', async () => {
  const client = publicClient({
    'POST /api/v1/market/klines': [
      [1612345678000, '5500000', '5600000', '5400000', '5550000', '10.5', 1612345738000],
      [1612345738000, '5550000', '5560000', '5540000', '5555000', '8.2', 1612345798000],
    ],
  });

  const candles = await client.getKlines({ symbol: 'BTCINR' });
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    t: 1612345678000,
    open: 5500000,
    high: 5600000,
    low: 5400000,
    close: 5550000,
    volume: 10.5,
    endTime: 1612345738000,
  });
});

test('getKlinesHistory pages backwards and de-duplicates by open time', async () => {
  const step = 60_000;
  const base = 1_700_000_000_000;
  let served = 0;
  const transport = {
    calls: [],
    async request(req) {
      transport.calls.push(req);
      served += 1;
      // Each page returns 3 candles ending at the requested `since`.
      const since = req.body.since ?? base;
      return [0, 1, 2].map((i) => {
        const t = since - (2 - i) * step;
        return [t, '1', '2', '0.5', '1.5', '3', t + step - 1];
      });
    },
  };
  const client = new ZebpayFuturesClient({ transport });

  const candles = await client.getKlinesHistory({
    symbol: 'BTCINR',
    timeframe: '1m',
    count: 6,
    pageSize: 3,
    until: base,
  });

  assert.ok(transport.calls.length >= 2, 'should have paged at least twice');
  assert.ok(candles.length >= 6, `expected >= 6 candles, got ${candles.length}`);
  const times = candles.map((c) => c.t);
  assert.deepEqual(times, [...new Set(times)].sort((a, b) => a - b), 'ascending and unique');
  void served;
});

test('getKlinesHistory stops when the server returns nothing', async () => {
  const transport = {
    calls: [],
    async request(req) {
      transport.calls.push(req);
      return [];
    },
  };
  const client = new ZebpayFuturesClient({ transport });
  const candles = await client.getKlinesHistory({ symbol: 'BTCINR', timeframe: '1m', count: 50 });
  assert.deepEqual(candles, []);
  assert.equal(transport.calls.length, 1, 'must not loop on an empty page');
});

/* ── Order validation ────────────────────────────────────────────────────── */

test('assertOrderShape enforces the documented order-type rules', () => {
  const base = { symbol: 'BTCINR', amount: 0.001, side: 'BUY' };

  assert.equal(assertOrderShape({ ...base, type: 'MARKET' }), true);
  assert.equal(assertOrderShape({ ...base, type: 'LIMIT', price: 7000000 }), true);
  assert.equal(assertOrderShape({ ...base, type: 'STOP_MARKET', triggerPrice: 6900000 }), true);
  assert.equal(
    assertOrderShape({ ...base, type: 'STOP_LIMIT', price: 7000000, triggerPrice: 6900000 }),
    true,
  );

  const cases = [
    [{ ...base, type: 'FOO' }, /order\.type/],
    [{ ...base, type: 'MARKET', side: 'HOLD' }, /order\.side/],
    [{ ...base, type: 'MARKET', amount: 0 }, /order\.amount/],
    [{ ...base, type: 'MARKET', amount: -1 }, /order\.amount/],
    [{ symbol: '', type: 'MARKET', side: 'BUY', amount: 1 }, /order\.symbol/],
    [{ ...base, type: 'LIMIT' }, /require a positive price/],
    [{ ...base, type: 'STOP_MARKET' }, /require a positive triggerPrice/],
    [{ ...base, type: 'STOP_LIMIT', price: 100, triggerPrice: 200 }, /BUY STOP_LIMIT/],
    [{ ...base, side: 'SELL', type: 'STOP_LIMIT', price: 300, triggerPrice: 200 }, /SELL STOP_LIMIT/],
  ];
  for (const [order, pattern] of cases) {
    assert.throws(() => assertOrderShape(order), pattern);
  }
});

test('createOrder validates client-side and normalizes the symbol', async () => {
  const t = stubTransport({ 'POST /api/v1/trade/order': { clientOrderId: 'x' } });
  const client = new ZebpayFuturesClient({ apiKey: 'AK', apiSecret: 'SK', transport: t });

  await client.createOrder({ symbol: 'BTC-INR', amount: 0.001, side: 'SELL', type: 'MARKET' });
  assert.equal(t.calls[0].body.symbol, 'BTCINR');
  assert.equal(t.calls[0].body.side, 'SELL');

  await assert.rejects(
    () => client.createOrder({ symbol: 'BTCINR', amount: 0.001, side: 'BUY', type: 'LIMIT' }),
    /positive price/,
  );
  assert.equal(t.calls.length, 1, 'invalid order must not reach the transport');
});

test('cancelOrder sends clientOrderId in the body', async () => {
  const t = stubTransport({ 'DELETE /api/v1/trade/order': {} });
  const client = privateClient({});
  client.transport = t;

  await client.cancelOrder('order-1', 'BTCINR');
  assert.equal(t.calls[0].method, 'DELETE');
  assert.deepEqual(t.calls[0].body, { clientOrderId: 'order-1', symbol: 'BTCINR' });

  await assert.rejects(() => client.cancelOrder(''), /clientOrderId is required/);
});

test('cancelAllOrders targets the /all route', async () => {
  const t = stubTransport({});
  const client = privateClient({});
  client.transport = t;
  await client.cancelAllOrders();
  assert.equal(t.calls[0].path, '/api/v1/trade/order/all');
  assert.equal(t.calls[0].method, 'DELETE');
});

test('addTPSL accepts exactly one trigger price', async () => {
  const t = stubTransport({ 'POST /api/v1/trade/order/addTPSL': {} });
  const client = privateClient({});
  client.transport = t;

  await client.addTpsl({ positionId: 'p1', symbol: 'BTCINR', takeProfitPrice: 8000000 });
  assert.deepEqual(t.calls[0].body, {
    positionId: 'p1',
    symbol: 'BTCINR',
    takeProfitPrice: 8000000,
  });

  await assert.rejects(
    () => client.addTpsl({ positionId: 'p1', takeProfitPrice: 1, stopLossPrice: 2 }),
    /exactly one/,
  );
  await assert.rejects(() => client.addTpsl({ positionId: 'p1' }), /exactly one/);
  await assert.rejects(() => client.addTpsl({ takeProfitPrice: 1 }), /positionId is required/);
});

test('margin and leverage calls validate amounts', async () => {
  const client = privateClient({});
  await assert.rejects(() => client.addMargin({ positionId: 'p', amount: 0 }), /positive number/);
  await assert.rejects(() => client.reduceMargin({ positionId: 'p', amount: -5 }), /positive number/);
  await assert.rejects(() => client.addMargin({ amount: 10 }), /positionId is required/);
  await assert.rejects(
    () => client.updateUserLeverage({ symbol: 'BTCINR', leverage: 0 }),
    /positive number/,
  );
});

test('closePosition requires a positionId', async () => {
  const client = privateClient({});
  await assert.rejects(() => client.closePosition({ symbol: 'BTCINR' }), /positionId is required/);
});

test('history endpoints pass the timestamp pagination cursor through', async () => {
  const t = stubTransport({});
  const client = privateClient({});
  client.transport = t;

  await client.getOrderHistory({ symbol: 'BTCINR', timestamp: 1712345678901, limit: 50 });
  await client.getTradeHistory({ timestamp: 1712345678901 });
  await client.getTransactionHistory({ type: 'COMMISSION', timestamp: 1 });

  assert.deepEqual(t.calls[0].query, { symbol: 'BTCINR', timestamp: 1712345678901, limit: 50 });
  assert.equal(t.calls[1].query.timestamp, 1712345678901);
  assert.equal(t.calls[2].query.type, 'COMMISSION');
});

test('getTradeFee and getUserLeverage send their symbol param', async () => {
  const t = stubTransport({});
  const client = privateClient({});
  client.transport = t;

  await client.getTradeFee('BTC-INR');
  await client.getUserLeverage('eth-inr');

  assert.equal(t.calls[0].path, '/api/v1/exchange/tradefee');
  assert.equal(t.calls[0].auth.type, 'none', 'tradefee is a public endpoint');
  assert.equal(t.calls[0].query.symbol, 'BTCINR');
  assert.equal(t.calls[1].query.symbol, 'ETHINR');
  assert.equal(t.calls[1].auth.type, 'apiKey');
});

test('measureClockSkew returns a plausible offset', async () => {
  const client = publicClient({ 'GET /api/v1/system/time': { timestamp: Date.now() + 500 } });
  const skew = await client.measureClockSkew();
  assert.ok(skew > 300 && skew < 700, `expected ~500ms skew, got ${skew}`);
});

/* ── Consistent async semantics ──────────────────────────────────────────── */

test('validation failures reject rather than throwing synchronously', async () => {
  const client = new ZebpayFuturesClient();

  // A method that sometimes throws and sometimes rejects cannot be awaited
  // safely, so every validating entry point must return a rejected promise.
  const rejecting = [
    () => client.getWalletBalance(),
    () => client.getPositions(),
    () => client.getOpenOrders(),
    () => client.cancelOrder(''),
    () => client.cancelAllOrders(),
    () => client.createOrder({ symbol: 'BTCINR', side: 'BUY', type: 'LIMIT', amount: 1 }),
    () => client.addTpsl({ positionId: 'p' }),
    () => client.closePosition({}),
    () => client.addMargin({ positionId: 'p', amount: -1 }),
    () => client.reduceMargin({ positionId: 'p', amount: 0 }),
    () => client.updateUserLeverage({ symbol: 'BTCINR', leverage: 0 }),
    () => client.getOrderBook(''),
    () => client.getKlines({ symbol: 'BTCINR', timeframe: '2m' }),
  ];

  for (const call of rejecting) {
    let returned;
    assert.doesNotThrow(() => {
      returned = call();
    }, 'must not throw synchronously');
    assert.ok(returned instanceof Promise, 'must return a promise');
    await assert.rejects(() => returned, ValidationError);
  }
});
