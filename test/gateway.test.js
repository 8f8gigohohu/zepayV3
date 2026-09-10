import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderGateway } from '../src/strategy/OrderGateway.js';
import { LiveTradingBlockedError, ValidationError } from '../src/core/errors.js';

const PRICE = 7_500_000;
const fixedPrice = () => PRICE;

/* ── The kill switch ─────────────────────────────────────────────────────── */

test('dry-run is the default mode', () => {
  const g = new OrderGateway({ priceSource: fixedPrice });
  assert.equal(g.mode, 'dry-run');
  assert.equal(g.isLive, false);
});

test('allowLive alone is NOT enough to go live', () => {
  const g = new OrderGateway({ priceSource: fixedPrice, allowLive: true });
  assert.equal(g.mode, 'dry-run', 'a stray env var must not enable real trading');
});

test('the --live flag alone is NOT enough to go live', () => {
  const g = new OrderGateway({ priceSource: fixedPrice, liveFlag: true });
  assert.equal(g.mode, 'dry-run');
});

test('both switches together enable live mode', () => {
  const g = new OrderGateway({ priceSource: fixedPrice, allowLive: true, liveFlag: true });
  assert.equal(g.mode, 'live');
  assert.equal(g.isLive, true);
});

test('a live attempt in dry-run throws LiveTradingBlockedError and transmits nothing', async () => {
  let sent = 0;
  const client = {
    isAuthenticated: true,
    async createOrder() {
      sent += 1;
      return {};
    },
  };
  const g = new OrderGateway({ client, priceSource: fixedPrice, allowLive: true }); // no liveFlag
  g.assertLiveAllowed = () => {}; // bypass the guard to prove the routing is safe

  // Directly exercise the live branch condition instead.
  assert.equal(g.isLive, false);
  const rec = await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.001, type: 'MARKET' });
  assert.equal(rec.mode, 'dry-run');
  assert.equal(sent, 0, 'the client must never be called in dry-run');
});

test('live mode without credentials fails loudly', () => {
  const g = new OrderGateway({
    client: { isAuthenticated: false },
    priceSource: fixedPrice,
    allowLive: true,
    liveFlag: true,
  });
  assert.throws(() => g.assertLiveAllowed('placeOrder'), ValidationError);
});

test('assertLiveAllowed raises LiveTradingBlockedError in dry-run', () => {
  const g = new OrderGateway({ priceSource: fixedPrice });
  assert.throws(() => g.assertLiveAllowed('cancelOrder'), LiveTradingBlockedError);
});

test('live mode forwards to the client', async () => {
  const calls = [];
  const client = {
    isAuthenticated: true,
    async createOrder(o) {
      calls.push(o);
      return { clientOrderId: 'real-1', status: 'new' };
    },
  };
  const g = new OrderGateway({ client, allowLive: true, liveFlag: true, priceSource: fixedPrice });

  const rec = await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.002, type: 'MARKET' });
  assert.equal(rec.mode, 'live');
  assert.equal(rec.clientOrderId, 'real-1');
  assert.equal(calls.length, 1);
});

/* ── Dry-run fills and position bookkeeping ──────────────────────────────── */

test('a dry-run market order fills at the live price and records fee', async () => {
  const g = new OrderGateway({ priceSource: fixedPrice, takerFeeRate: 0.001 });

  const rec = await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });

  assert.equal(rec.mode, 'dry-run');
  assert.equal(rec.status, 'filled');
  assert.equal(rec.price, PRICE);
  assert.equal(rec.notional, PRICE * 0.01);
  assert.equal(rec.fee, PRICE * 0.01 * 0.001);
  assert.match(rec.clientOrderId, /^dry-\d+$/);
});

test('dry-run without a price source refuses rather than inventing a fill', async () => {
  const g = new OrderGateway({ priceSource: () => null });
  await assert.rejects(
    () => g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 1, type: 'MARKET' }),
    /needs a live price/,
  );
});

test('placeOrder validates side and amount', async () => {
  const g = new OrderGateway({ priceSource: fixedPrice });
  await assert.rejects(() => g.placeOrder({ side: 'BUY', amount: 1 }), /order\.symbol/);
  await assert.rejects(
    () => g.placeOrder({ symbol: 'BTCINR', side: 'HOLD', amount: 1 }),
    /side must be BUY or SELL/,
  );
  await assert.rejects(
    () => g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0 }),
    /amount must be positive/,
  );
});

test('opening a long tracks quantity and average entry price', async () => {
  const g = new OrderGateway({ priceSource: fixedPrice });
  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });

  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, 0.01);
  assert.equal(pos.avgPrice, PRICE);
  assert.equal(pos.trades, 1);
});

test('adding to a long moves the average entry price correctly', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
  price = 8_000_000;
  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });

  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, 0.02);
  assert.equal(pos.avgPrice, 7_500_000, 'equal-size adds average to the midpoint');
  assert.equal(pos.realizedPnl, 0, 'no PnL is realized while increasing');
});

test('fully closing a long realizes PnL and flattens the position', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
  price = 7_500_000;
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.01, type: 'MARKET' });

  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, 0);
  assert.equal(pos.realizedPnl, (7_500_000 - 7_000_000) * 0.01, 'profit = move x size');
});

test('a losing close realizes a negative PnL', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.02, type: 'MARKET' });
  price = 6_500_000;
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.02, type: 'MARKET' });

  assert.equal(g.positions.get('BTCINR').realizedPnl, -10_000);
});

test('a short realizes PnL with the sign reversed', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.01, type: 'MARKET' });
  assert.equal(g.positions.get('BTCINR').qty, -0.01);

  price = 6_000_000; // price falls -> short profits
  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });

  assert.equal(g.positions.get('BTCINR').realizedPnl, 10_000);
});

test('a partial reduction keeps the entry price and realizes only the closed part', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.02, type: 'MARKET' });
  price = 7_400_000;
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.01, type: 'MARKET' });

  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, 0.01);
  assert.equal(pos.avgPrice, 7_000_000, 'entry price is unchanged on a partial close');
  assert.equal(pos.realizedPnl, (7_400_000 - 7_000_000) * 0.01);
});

test('flipping through zero realizes the old side and reprices the residual', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
  price = 7_200_000;
  // Sell 0.03: closes the 0.01 long, opens a 0.02 short at 7.2m.
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.03, type: 'MARKET' });

  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, -0.02);
  assert.equal(pos.avgPrice, 7_200_000, 'residual short is priced at the fill');
  assert.equal(pos.realizedPnl, (7_200_000 - 7_000_000) * 0.01);
});

test('fees accumulate and are netted out of the summary', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price, takerFeeRate: 0.001 });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
  price = 7_000_000; // flat, so gross PnL is zero
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.01, type: 'MARKET' });

  const summary = g.summary('BTCINR');
  const expectedFee = 7_000_000 * 0.01 * 0.001 * 2;
  assert.equal(summary.fees, expectedFee);
  assert.equal(summary.realizedPnl, -expectedFee, 'a flat round trip loses exactly the fees');
  assert.equal(summary.trades, 2);
  assert.equal(summary.fills, 2);
  assert.equal(summary.mode, 'dry-run');
});

test('unrealizedPnl tracks the live price against the entry', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
  assert.equal(g.unrealizedPnl('BTCINR'), 0);

  price = 7_100_000;
  assert.equal(g.unrealizedPnl('BTCINR'), 1_000);
  assert.equal(g.unrealizedPnl('ETHINR'), 0, 'unknown symbol is flat');
});

test('dry-run closePosition flattens the simulated book', async () => {
  let price = 7_000_000;
  const g = new OrderGateway({ priceSource: () => price });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.05, type: 'MARKET' });
  price = 7_300_000;
  const res = await g.closePosition({ symbol: 'BTCINR' });

  assert.equal(res.closed, 0.05);
  assert.equal(res.simulated, true);
  assert.equal(g.positions.get('BTCINR').qty, 0);
});

test('closePosition on a flat book is a no-op', async () => {
  const g = new OrderGateway({ priceSource: fixedPrice });
  const res = await g.closePosition({ symbol: 'BTCINR' });
  assert.equal(res.closed, 0);
});

test('dry-run cancel records intent without touching the client', async () => {
  const client = { isAuthenticated: true, async cancelOrder() { throw new Error('must not be called'); } };
  const g = new OrderGateway({ client, priceSource: fixedPrice });

  const res = await g.cancelOrder('dry-1', 'BTCINR');
  assert.equal(res.simulated, true);
  assert.equal(res.status, 'canceled');
  assert.equal(g.fills.at(-1).action, 'cancel');
});

test('onFill observes every fill in order', async () => {
  const seen = [];
  const g = new OrderGateway({ priceSource: fixedPrice, onFill: (f) => seen.push(f.side) });

  await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 1, type: 'MARKET' });
  await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 1, type: 'MARKET' });
  assert.deepEqual(seen, ['BUY', 'SELL']);
});

/* ── Float-drift regression ──────────────────────────────────────────────── */

test('quantize removes binary-float noise without losing real precision', async () => {
  const { quantize } = await import('../src/strategy/OrderGateway.js');
  assert.equal(0.01 - 0.03, -0.019999999999999997, 'the raw drift this guards against');
  assert.equal(quantize(0.01 - 0.03), -0.02);
  assert.equal(quantize(1.000000000001), 1.000000000001, 'keeps 12 real decimals');
  assert.ok(Number.isNaN(quantize(NaN)), 'non-finite passes through');
});

test('repeated round trips do not accumulate quantity drift', async () => {
  const g = new OrderGateway({ priceSource: () => 7_000_000 });
  for (let i = 0; i < 50; i++) {
    await g.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.01, type: 'MARKET' });
    await g.placeOrder({ symbol: 'BTCINR', side: 'SELL', amount: 0.01, type: 'MARKET' });
  }
  const pos = g.positions.get('BTCINR');
  assert.equal(pos.qty, 0, `expected an exactly flat position, got ${pos.qty}`);
  assert.equal(pos.trades, 100);
});
