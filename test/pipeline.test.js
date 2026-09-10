import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousPipeline } from '../src/autonomous/pipeline.js';
import { createDecisionEngine } from '../src/ai/engine.js';
import { RiskEngine } from '../src/risk/engine.js';
import { PermissionEngine } from '../src/permissions/engine.js';
import { KillSwitch } from '../src/risk/killswitch.js';
import { OrderGateway } from '../src/strategy/OrderGateway.js';
import { AuditLog } from '../src/audit/log.js';
import { discoverUniverse, fetchSymbolData } from '../src/scanner/scanner.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function candles(prices) {
  return prices.map((close, i) => ({
    t: T0 + i * MIN,
    open: prices[i - 1] ?? close,
    high: Math.max(close, prices[i - 1] ?? close) * 1.002,
    low: Math.min(close, prices[i - 1] ?? close) * 0.998,
    close,
    volume: 10,
    endTime: T0 + (i + 1) * MIN - 1,
  }));
}
const uptrend = (n = 80) => Array.from({ length: n }, (_, i) => 7_000_000 * 1.004 ** i);
const BOOK = {
  bids: Array.from({ length: 20 }, (_, i) => [7_000_000 - (i + 1) * 100, 5]),
  asks: Array.from({ length: 20 }, (_, i) => [7_000_000 + (i + 1) * 100, 5]),
};

/** Assemble a pipeline with all real components and stubbed I/O. */
function makePipeline({
  candles: cs = candles(uptrend()),
  book = BOOK,
  dataAgeMs = 100,
  equity = 100_000,
  openPositions = [],
  permissions = {},
  riskLimits = {},
  allowLive = false,
  liveFlag = false,
} = {}) {
  const audit = new AuditLog();
  const killSwitch = new KillSwitch();
  const perm = new PermissionEngine({ autonomousEntries: true, autonomousExits: true, ...permissions });
  const risk = new RiskEngine(riskLimits);
  const orders = [];
  const gateway = new OrderGateway({
    priceSource: () => cs.at(-1).close,
    allowLive,
    liveFlag,
    onFill: (f) => orders.push(f),
  });

  const pipeline = new AutonomousPipeline({
    ai: createDecisionEngine(),
    risk,
    permissions: perm,
    killSwitch,
    gateway,
    audit,
    fetchSymbol: async () => ({ candles: cs, book, dataAgeMs }),
    fetchAccount: async () => ({
      equity, openPositions, dailyPnlPct: 0, weeklyPnlPct: 0,
      drawdownPct: 0, consecutiveLosses: 0, apiHealthy: true,
    }),
  });

  return { pipeline, audit, killSwitch, perm, risk, gateway, orders };
}

/* ── Construction ────────────────────────────────────────────────────────── */

test('the pipeline refuses to run without its safety dependencies', () => {
  const base = {
    ai: createDecisionEngine(),
    risk: new RiskEngine(),
    permissions: new PermissionEngine(),
    killSwitch: new KillSwitch(),
    gateway: new OrderGateway({ priceSource: () => 1 }),
    audit: new AuditLog(),
    fetchSymbol: async () => ({}),
    fetchAccount: async () => ({}),
  };
  for (const key of Object.keys(base)) {
    const partial = { ...base };
    delete partial[key];
    assert.throws(() => new AutonomousPipeline(partial), new RegExp(key), `missing ${key} must throw`);
  }
});

/* ── The full gate sequence ──────────────────────────────────────────────── */

test('a clean setup passes every gate and executes a dry-run order', async () => {
  const { pipeline, orders, audit } = makePipeline();
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.stage, 'approved');
  assert.equal(trace.action, 'LONG');
  assert.equal(trace.riskVerdict.approved, true);
  assert.equal(trace.permission.allowed, true);

  assert.ok(execution, 'an approved trade must reach the gateway');
  assert.equal(execution.mode, 'dry-run');
  assert.equal(orders.length, 1);

  // Every gate must leave an audit record.
  const types = audit.records.map((r) => r.type);
  assert.ok(types.includes('RISK_VERDICT'));
  assert.ok(types.includes('AI_DECISION'));
  assert.ok(types.includes('ORDER_SENT'));
});

test('the projection exposes net P&L after costs, never gross', async () => {
  const { pipeline } = makePipeline();
  const trace = await pipeline.evaluate('BTCINR');

  assert.ok(trace.projection, 'a proposed trade must carry a cost projection');
  assert.ok(trace.projection.netPnl < trace.projection.grossPnl, 'net must be below gross');
  assert.ok(trace.projection.costs.total > 0);
  // Liquidation may legitimately be null at sub-1x leverage — what matters is
  // that the figure is never a fabricated zero.
  assert.ok(
    trace.projection.liquidationPrice === null || trace.projection.liquidationPrice > 0,
    `unexpected liquidation price ${trace.projection.liquidationPrice}`,
  );
});

test('the AI never reaches the gateway directly', async () => {
  const { pipeline } = makePipeline();
  // The decision engine has no reference to the gateway at all.
  assert.equal(pipeline.ai.gateway, undefined);
  assert.equal(typeof pipeline.ai.placeOrder, 'undefined');
});

/* ── NO_TRADE paths ──────────────────────────────────────────────────────── */

test('NO_TRADE produces reasons and places no order', async () => {
  const flat = candles(Array.from({ length: 80 }, (_, i) => 7_000_000 * (1 + (i % 2 ? 0.0004 : -0.0004))));
  const { pipeline, orders, audit } = makePipeline({ candles: flat });
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(execution, null);
  assert.equal(orders.length, 0, 'nothing may be sent on a NO_TRADE');
  assert.ok(trace.reasons.length > 0, 'the user must be told why');
  assert.ok(audit.records.some((r) => r.type === 'NO_TRADE'));
});

test('the kill switch blocks before any market data is fetched', async () => {
  const { pipeline, killSwitch, orders } = makePipeline();
  let fetched = 0;
  pipeline.fetchSymbol = async () => {
    fetched += 1;
    return { candles: candles(uptrend()), book: BOOK, dataAgeMs: 0 };
  };

  killSwitch.engage('operator stop');
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.stage, 'kill_switch');
  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(execution, null);
  assert.equal(fetched, 0, 'must short-circuit before doing any work');
  assert.equal(orders.length, 0);
});

test('missing market data yields NO_TRADE, not a crash', async () => {
  const { pipeline } = makePipeline();
  pipeline.fetchSymbol = async () => {
    throw new Error('socket closed');
  };
  const { trace, execution } = await pipeline.runSymbol('BTCINR');
  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(execution, null);
  assert.match(trace.reasons[0], /market data unavailable/);
});

test('empty candle history yields NO_TRADE', async () => {
  const { pipeline } = makePipeline();
  pipeline.fetchSymbol = async () => ({ candles: [], book: null, dataAgeMs: null });
  const { trace } = await pipeline.runSymbol('BTCINR');
  assert.equal(trace.action, 'NO_TRADE');
  assert.match(trace.reasons[0], /no candles/);
});

/* ── Risk and permission gates ───────────────────────────────────────────── */

test('the risk engine can veto an AI-approved trade', async () => {
  // Impossibly strict edge requirement: the AI will propose, risk will refuse.
  const { pipeline, orders } = makePipeline({ riskLimits: { minNetEdgePct: 50 } });
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.stage, 'risk');
  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(trace.riskVerdict.approved, false);
  assert.equal(trace.riskVerdict.code, 'NET_EDGE');
  assert.equal(execution, null);
  assert.equal(orders.length, 0);
});

test('the permission engine blocks autonomous entries when disabled', async () => {
  const { pipeline, orders } = makePipeline({ permissions: { autonomousEntries: false } });
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.stage, 'permission');
  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(trace.permission.allowed, false);
  assert.equal(orders.length, 0);
});

test('a live send stays blocked unless every independent gate is open', async () => {
  // Permission granted and pipeline approves, but the gateway's own gate is shut.
  const { pipeline, orders } = makePipeline({
    permissions: { liveTrading: true, autonomousEntries: true },
    allowLive: false,
  });
  const { trace, execution } = await pipeline.runSymbol('BTCINR');

  assert.equal(trace.action, 'LONG');
  assert.equal(execution.mode, 'dry-run', 'gateway still simulates');
  assert.equal(orders[0].mode, 'dry-run');
});

/* ── Scan cycle ──────────────────────────────────────────────────────────── */

test('runCycle ranks symbols and acts on at most one', async () => {
  const flat = candles(Array.from({ length: 80 }, (_, i) => 7_000_000 * (1 + (i % 2 ? 0.0004 : -0.0004))));
  const { pipeline, audit, orders } = makePipeline();
  pipeline.fetchSymbol = async (symbol) => ({
    candles: symbol === 'BTCINR' ? candles(uptrend()) : flat,
    book: BOOK,
    dataAgeMs: 100,
  });

  const { ranked, acted } = await pipeline.runCycle(['BTCINR', 'ETHINR', 'XRPINR']);

  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].score >= ranked[1].score, 'ranked descending by score');
  assert.ok(acted, 'the trending symbol should be actionable');
  assert.equal(acted.trace.action, 'LONG');
  assert.equal(orders.length, 1, 'never more than one position per cycle');
  assert.ok(audit.records.some((r) => r.type === 'SCAN_CYCLE'));
});

test('runCycle with no opportunities acts on nothing', async () => {
  const flat = candles(Array.from({ length: 80 }, (_, i) => 7_000_000 * (1 + (i % 2 ? 0.0004 : -0.0004))));
  const { pipeline, orders } = makePipeline({ candles: flat });
  const { acted } = await pipeline.runCycle(['BTCINR', 'ETHINR']);
  assert.equal(acted, null);
  assert.equal(orders.length, 0);
});

test('a data failure is captured per-symbol without killing the cycle', async () => {
  const { pipeline } = makePipeline();
  pipeline.fetchSymbol = async (symbol) => {
    if (symbol === 'BADINR') throw new Error('boom');
    return { candles: candles(uptrend()), book: BOOK, dataAgeMs: 0 };
  };
  const { ranked } = await pipeline.runCycle(['BADINR', 'BTCINR']);
  const bad = ranked.find((r) => r.symbol === 'BADINR');
  assert.equal(bad.action, 'NO_TRADE');
  // Handled inside evaluate() rather than escaping to the cycle's own catch —
  // the failure is attributed to the symbol either way.
  assert.match(bad.reason, /market data unavailable: boom/);
  assert.equal(ranked.length, 2, 'the good symbol is still evaluated');
});

test('a failure inside evaluate is still caught by the cycle guard', async () => {
  const { pipeline } = makePipeline();
  // Bypass the internal try/catch by breaking the AI itself.
  pipeline.ai = { decide: () => { throw new Error('model exploded'); } };
  const { ranked, acted } = await pipeline.runCycle(['BTCINR']);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].action, 'NO_TRADE');
  assert.match(ranked[0].reason, /evaluation failed: model exploded/);
  assert.equal(acted, null);
});

test('status reports cycles, executions and safety state', async () => {
  const { pipeline } = makePipeline();
  await pipeline.runSymbol('BTCINR');
  const s = pipeline.status();
  assert.equal(s.executions, 1);
  assert.equal(s.noTrades, 0);
  assert.equal(s.killSwitch.blocked, false);
  assert.equal(s.permissions.liveTrading, false);
});

/* ── Scanner ─────────────────────────────────────────────────────────────── */

const MARKETS = {
  symbols: [
    { symbol: 'BTCINR', status: 'Open', baseAsset: 'BTC', quoteAsset: 'INR', maxLeverage: 50, pricePrecision: 0, quantityPrecision: 5, makerFee: 0.05, takerFee: 0.1 },
    { symbol: 'ETHINR', status: 'Open', baseAsset: 'ETH', quoteAsset: 'INR', maxLeverage: 20, pricePrecision: 2, quantityPrecision: 4, makerFee: 0.05, takerFee: 0.1 },
    { symbol: 'XYZINR', status: 'Closed', baseAsset: 'XYZ', quoteAsset: 'INR', maxLeverage: 10 },
    { symbol: 'BTCUSDT', status: 'Open', baseAsset: 'BTC', quoteAsset: 'USDT', maxLeverage: 50 },
    { symbol: 'LOWINR', status: 'Open', baseAsset: 'LOW', quoteAsset: 'INR', maxLeverage: 1 },
  ],
};

const stubClient = (data) => ({
  async getMarkets() { return MARKETS; },
  async getOrderBook(symbol) { return { symbol, ...BOOK }; },
  async getKlinesHistory({ symbol, count }) { return candles(uptrend(count)).slice(-count); },
  async getTicker24Hr(symbol) { return { symbol, last: 100, percentage: 1, high: 110, low: 90, baseVolume: 50, bid: 99, ask: 101 }; },
  ...data,
});

test('discoverUniverse filters by status, quote asset and leverage', async () => {
  const u = await discoverUniverse({ client: stubClient() });
  const symbols = u.map((m) => m.symbol);

  assert.ok(symbols.includes('BTCINR'));
  assert.ok(symbols.includes('ETHINR'));
  assert.ok(!symbols.includes('XYZINR'), 'closed pairs are excluded');
  assert.ok(!symbols.includes('BTCUSDT'), 'INR-only by default');
  assert.ok(!symbols.includes('LOWINR'), 'leverage below the minimum is excluded');
});

test('discoverUniverse is deterministic and honours allow/deny lists', async () => {
  const a = await discoverUniverse({ client: stubClient() });
  const b = await discoverUniverse({ client: stubClient() });
  assert.deepEqual(a.map((m) => m.symbol), b.map((m) => m.symbol), 'must be reproducible');

  const denied = await discoverUniverse({ client: stubClient(), filter: { denyList: ['BTCINR'] } });
  assert.ok(!denied.map((m) => m.symbol).includes('BTCINR'));

  const only = await discoverUniverse({ client: stubClient(), filter: { allowList: ['ETHINR'] } });
  assert.deepEqual(only.map((m) => m.symbol), ['ETHINR']);
});

test('discoverUniverse can include other quote assets when configured', async () => {
  const u = await discoverUniverse({ client: stubClient(), filter: { quoteAssets: ['INR', 'USDT'] } });
  assert.ok(u.map((m) => m.symbol).includes('BTCUSDT'));
});

test('fetchSymbolData stamps data age from the last candle', async () => {
  const last = candles(uptrend(10)).at(-1);
  const d = await fetchSymbolData({ client: stubClient(), symbol: 'BTCINR', candleCount: 10, now: () => last.endTime + 500 });
  assert.equal(d.dataAgeMs, 500);
  assert.equal(d.book.bids.length, BOOK.bids.length);
});

test('fetchSymbolData tolerates a missing order book', async () => {
  const client = stubClient({
    async getOrderBook() { throw new Error('rate limited'); },
  });
  const d = await fetchSymbolData({ client, symbol: 'BTCINR', candleCount: 10 });
  assert.equal(d.book, null, 'a missing book is recorded, never fabricated');
  assert.ok(d.candles.length > 0);
});
