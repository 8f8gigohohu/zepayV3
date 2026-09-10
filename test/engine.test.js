import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyEngine, dropFormingCandle } from '../src/strategy/engine.js';
import { OrderGateway } from '../src/strategy/OrderGateway.js';
import { createEmaCrossStrategy } from '../src/strategy/strategies/emaCross.js';
import { ValidationError } from '../src/core/errors.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** Build ascending 1m candles. */
function candles(prices, start = T0) {
  return prices.map((close, i) => ({
    t: start + i * MIN,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1,
    endTime: start + (i + 1) * MIN - 1,
  }));
}

const stubClient = (history = []) => ({
  isAuthenticated: false,
  async getKlinesHistory() {
    return history;
  },
});

/* ── dropFormingCandle ───────────────────────────────────────────────────── */

test('dropFormingCandle removes the candle still in progress', () => {
  const cs = candles([1, 2, 3]);
  const now = cs[2].t + 1000; // third candle has not ended
  const out = dropFormingCandle(cs, now);
  assert.equal(out.length, 2);
  assert.equal(out.at(-1).close, 2);
});

test('dropFormingCandle keeps a candle once its endTime has passed', () => {
  const cs = candles([1, 2, 3]);
  const out = dropFormingCandle(cs, cs[2].endTime + 1);
  assert.equal(out.length, 3);
});

test('dropFormingCandle handles empty and fully-forming input', () => {
  assert.deepEqual(dropFormingCandle([], Date.now()), []);
  const cs = candles([1]);
  assert.deepEqual(dropFormingCandle(cs, cs[0].t), [], 'a lone forming candle leaves nothing');
});

/* ── Engine construction ─────────────────────────────────────────────────── */

test('the engine requires a client, gateway, strategy and symbol', () => {
  const gateway = new OrderGateway({ priceSource: () => 1 });
  const strategy = createEmaCrossStrategy();
  assert.throws(() => new StrategyEngine({ gateway, strategy, symbol: 'BTCINR' }), /requires a client/);
  assert.throws(
    () => new StrategyEngine({ client: stubClient(), strategy, symbol: 'BTCINR' }),
    /requires an order gateway/,
  );
  assert.throws(
    () => new StrategyEngine({ client: stubClient(), gateway, symbol: 'BTCINR' }),
    /must implement onCandles/,
  );
  assert.throws(() => new StrategyEngine({ client: stubClient(), gateway, strategy }), /requires a symbol/);
});

test('the engine normalizes the symbol', () => {
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: createEmaCrossStrategy(),
    symbol: 'BTC-INR',
  });
  assert.equal(engine.symbol, 'BTCINR');
});

/* ── tick() ──────────────────────────────────────────────────────────────── */

test('tick skips when there are no closed candles', async () => {
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: createEmaCrossStrategy(),
    symbol: 'BTCINR',
  });

  const skips = [];
  engine.on('skip', (s) => skips.push(s.reason));
  const cs = candles([1, 2, 3]);
  // `now` at the first candle's open time means every candle is still forming.
  const res = await engine.tick({ candles: cs, now: cs[0].t });

  assert.equal(res, null);
  assert.deepEqual(skips, ['no closed candles yet']);
});

test('tick acts on a given closed candle only once', async () => {
  const signals = [];
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'HOLD', reason: 'test' }) },
    symbol: 'BTCINR',
  });
  engine.on('skip', (s) => signals.push(s.reason));

  const cs = candles([1, 2, 3, 4]);
  const now = cs.at(-1).endTime + 1;

  await engine.tick({ candles: cs, now });
  await engine.tick({ candles: cs, now });
  await engine.tick({ candles: cs, now });

  assert.deepEqual(signals, ['no new closed candle', 'no new closed candle']);
  assert.equal(engine.ticks, 3);
});

test('tick executes a BUY signal through the gateway', async () => {
  const gateway = new OrderGateway({ priceSource: () => 7_000_000 });
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway,
    strategy: { onCandles: () => ({ action: 'BUY', amount: 0.01, reason: 'cross up' }) },
    symbol: 'BTCINR',
    orderAmount: 0.01,
  });

  const cs = candles([1, 2, 3, 4]);
  const rec = await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });

  assert.equal(rec.signal.action, 'BUY');
  assert.equal(rec.executed.mode, 'dry-run');
  assert.equal(rec.executed.price, 7_000_000);
  assert.equal(gateway.positions.get('BTCINR').qty, 0.01);
  assert.equal(engine.lastSignal.action, 'BUY');
});

test('tick emits a signal event with the candle time', async () => {
  const seen = [];
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'BUY', amount: 1 }) },
    symbol: 'BTCINR',
  });
  engine.on('signal', (r) => seen.push(r));

  const cs = candles([1, 2, 3]);
  await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].candleTime, cs.at(-1).t);
});

test('CLOSE flattens the simulated position', async () => {
  const gateway = new OrderGateway({ priceSource: () => 7_000_000 });
  await gateway.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.02, type: 'MARKET' });

  const engine = new StrategyEngine({
    client: stubClient(),
    gateway,
    strategy: { onCandles: () => ({ action: 'CLOSE', reason: 'exit' }) },
    symbol: 'BTCINR',
  });

  const cs = candles([1, 2, 3]);
  const rec = await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });

  assert.equal(gateway.positions.get('BTCINR').qty, 0);
  assert.ok(rec.executed.simulated);
});

test('a HOLD signal leaves the position untouched', async () => {
  const gateway = new OrderGateway({ priceSource: () => 1 });
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway,
    strategy: { onCandles: () => ({ action: 'HOLD' }) },
    symbol: 'BTCINR',
  });

  const cs = candles([1, 2, 3]);
  const res = await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });
  assert.equal(res, null);
  assert.equal(gateway.fills.length, 0);
});

test('an unknown action is captured as an error, not thrown out of tick', async () => {
  const errors = [];
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'MOON' }) },
    symbol: 'BTCINR',
  });
  engine.on('error', (e) => errors.push(e));

  const cs = candles([1, 2, 3]);
  const rec = await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });

  assert.ok(rec.error instanceof ValidationError);
  assert.equal(errors.length, 1);
  assert.equal(engine.errors, 1);
});

test('a strategy that throws does not wedge the loop on the same candle', async () => {
  const skips = [];
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: {
      onCandles: () => {
        throw new Error('boom');
      },
    },
    symbol: 'BTCINR',
  });
  engine.on('error', () => {});
  engine.on('skip', (s) => skips.push(s.reason));

  const cs = candles([1, 2, 3]);
  const now = cs.at(-1).endTime + 1;
  await engine.tick({ candles: cs, now });
  await engine.tick({ candles: cs, now });

  assert.equal(engine.errors, 1, 'error counted once');
  assert.deepEqual(skips, ['no new closed candle'], 'cursor advanced past the bad candle');
});

test('the strategy receives position size and last price in ctx', async () => {
  const gateway = new OrderGateway({ priceSource: () => 7_000_000 });
  await gateway.placeOrder({ symbol: 'BTCINR', side: 'BUY', amount: 0.03, type: 'MARKET' });

  let seenCtx = null;
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway,
    strategy: {
      onCandles: ({ ctx }) => {
        seenCtx = ctx;
        return { action: 'HOLD' };
      },
    },
    symbol: 'BTCINR',
    orderAmount: 0.05,
  });

  const cs = candles([10, 20, 30]);
  await engine.tick({ candles: cs, now: cs.at(-1).endTime + 1 });

  assert.equal(seenCtx.positionQty, 0.03);
  assert.equal(seenCtx.orderAmount, 0.05);
  assert.equal(seenCtx.lastPrice, 30);
  assert.equal(seenCtx.symbol, 'BTCINR');
  assert.equal(seenCtx.candles.length, 3);
});

test('tick fetches from the client when candles are not supplied', async () => {
  const history = candles([1, 2, 3, 4, 5]);
  const engine = new StrategyEngine({
    client: stubClient(history),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'HOLD' }) },
    symbol: 'BTCINR',
  });

  await engine.tick({ now: history.at(-1).endTime + 1 });
  assert.equal(engine.candles.length, 5);
});

/* ── status / lifecycle ──────────────────────────────────────────────────── */

test('status reports the running mode and position summary', async () => {
  const gateway = new OrderGateway({ priceSource: () => 7_000_000 });
  const engine = new StrategyEngine({
    client: stubClient(),
    gateway,
    strategy: { onCandles: () => ({ action: 'HOLD' }) },
    symbol: 'BTCINR',
  });

  const s = engine.status();
  assert.equal(s.mode, 'dry-run');
  assert.equal(s.running, false);
  assert.equal(s.symbol, 'BTCINR');
  assert.equal(s.position.qty, 0);
});

test('start emits a warmup event and stop halts the loop', async () => {
  const events = [];
  const engine = new StrategyEngine({
    client: stubClient(candles([1, 2, 3, 4])),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'HOLD' }) },
    symbol: 'BTCINR',
    pollMs: 5,
  });
  engine.on('warmup', (e) => events.push(['warmup', e.candles]));
  engine.on('stop', (e) => events.push(['stop', e.ticks]));

  await engine.start();
  assert.equal(engine.running, true);
  await new Promise((r) => setTimeout(r, 30));

  engine.stop();
  assert.equal(engine.running, false);
  assert.equal(events[0][0], 'warmup');
  assert.equal(events.at(-1)[0], 'stop');
  assert.ok(engine.ticks >= 1, 'the loop should have ticked at least once');
});

test('start is idempotent', async () => {
  const engine = new StrategyEngine({
    client: stubClient([]),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { onCandles: () => ({ action: 'HOLD' }) },
    symbol: 'BTCINR',
    pollMs: 1000,
  });
  await engine.start();
  await engine.start();
  assert.equal(engine.running, true);
  engine.stop();
});

/* ── EMA cross strategy ──────────────────────────────────────────────────── */

test('the strategy holds while warming up', () => {
  const s = createEmaCrossStrategy({ fastPeriod: 3, slowPeriod: 5 });
  const out = s.onCandles({ candles: candles([1, 2, 3]), ctx: {} });
  assert.equal(out.action, 'HOLD');
  assert.match(out.reason, /warming up|not enough/);
});

test('the strategy buys on a bullish cross and holds while the cross persists', () => {
  const s = createEmaCrossStrategy({ fastPeriod: 3, slowPeriod: 5 });
  // Downtrend then a sharp upturn -> fast crosses above slow.
  const prices = [100, 99, 98, 97, 96, 95, 94, 95, 99, 105];
  const cs = candles(prices);

  const actions = prices.map((_, i) =>
    s.onCandles({ candles: cs.slice(0, i + 1), ctx: {} }).action,
  );
  assert.ok(actions.includes('BUY'), `expected a BUY, got ${actions.join(',')}`);
  const buys = actions.filter((a) => a === 'BUY').length;
  assert.equal(buys, 1, 'a sustained trend must not re-enter on every bar');
});

test('the strategy flattens on a bearish cross when shorts are disabled', () => {
  const s = createEmaCrossStrategy({ fastPeriod: 3, slowPeriod: 5, allowShort: false });
  const prices = [100, 101, 102, 103, 104, 105, 106, 104, 100, 92];
  const cs = candles(prices);

  const actions = prices.map((_, i) =>
    s.onCandles({ candles: cs.slice(0, i + 1), ctx: {} }).action,
  );
  assert.ok(actions.includes('CLOSE'), `expected a CLOSE, got ${actions.join(',')}`);
  assert.ok(!actions.includes('SELL'), 'must not short when allowShort is false');
});

test('the strategy shorts on a bearish cross when enabled', () => {
  const s = createEmaCrossStrategy({ fastPeriod: 3, slowPeriod: 5, allowShort: true });
  const prices = [100, 101, 102, 103, 104, 105, 106, 104, 100, 92];
  const cs = candles(prices);

  const actions = prices.map((_, i) =>
    s.onCandles({ candles: cs.slice(0, i + 1), ctx: {} }).action,
  );
  assert.ok(actions.includes('SELL'), `expected a SELL, got ${actions.join(',')}`);
});

test('the strategy rejects fast >= slow', () => {
  assert.throws(() => createEmaCrossStrategy({ fastPeriod: 21, slowPeriod: 9 }), TypeError);
  assert.throws(() => createEmaCrossStrategy({ fastPeriod: 9, slowPeriod: 9 }), TypeError);
});

test('the strategy carries its configuration in params and name', () => {
  const s = createEmaCrossStrategy({ fastPeriod: 5, slowPeriod: 13 });
  assert.equal(s.name, 'ema-cross(5,13)');
  assert.equal(s.params.fastPeriod, 5);
  assert.equal(s.params.allowShort, false);
});
