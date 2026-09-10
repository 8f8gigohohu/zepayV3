import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAutonomous,
  readEquity,
  normalisePositions,
  simulatedPositions,
} from '../src/commands/ai-factory.js';
import { AutonomousRunner } from '../src/autonomous/runner.js';
import { AutonomousPipeline } from '../src/autonomous/pipeline.js';
import { createDecisionEngine } from '../src/ai/engine.js';
import { RiskEngine } from '../src/risk/engine.js';
import { PermissionEngine } from '../src/permissions/engine.js';
import { KillSwitch } from '../src/risk/killswitch.js';
import { OrderGateway } from '../src/strategy/OrderGateway.js';
import { AuditLog } from '../src/audit/log.js';
import { DemoMarketFeed } from '../src/server/marketFeed.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const UP = Array.from({ length: 80 }, (_, i) => 7_000_000 * 1.004 ** i);

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

const BOOK = {
  bids: Array.from({ length: 20 }, (_, i) => [7_000_000 - (i + 1) * 100, 5]),
  asks: Array.from({ length: 20 }, (_, i) => [7_000_000 + (i + 1) * 100, 5]),
};

/** A pipeline wired to real components with stubbed I/O. */
function rig({ riskLimits = {}, equity = 100_000, minScore = 0.35 } = {}) {
  const orders = [];
  const killSwitch = new KillSwitch();
  const gateway = new OrderGateway({
    priceSource: () => UP.at(-1),
    allowLive: false,
    liveFlag: false,
    onFill: (f) => orders.push(f),
  });
  // Positions are read back from the gateway so the risk engine sees what it
  // just opened — the same wiring buildAutonomous uses in paper mode.
  const pipeline = new AutonomousPipeline({
    ai: createDecisionEngine({ minScore }),
    risk: new RiskEngine(riskLimits),
    permissions: new PermissionEngine({ autonomousEntries: true, autonomousExits: true }),
    killSwitch,
    gateway,
    audit: new AuditLog(),
    fetchSymbol: async () => ({ candles: candles(UP), book: BOOK, dataAgeMs: 100 }),
    fetchAccount: async () => ({
      equity,
      openPositions: simulatedPositions(gateway),
      dailyPnlPct: 0, weeklyPnlPct: 0, drawdownPct: 0, consecutiveLosses: 0, apiHealthy: true,
    }),
  });
  return { pipeline, runner: new AutonomousRunner({ pipeline, symbols: ['BTCINR'] }), killSwitch, gateway, orders };
}

/* ── Runner construction ─────────────────────────────────────────────────── */

test('the runner refuses to run without a pipeline or a symbol source', () => {
  assert.throws(() => new AutonomousRunner({}), /pipeline/);
  assert.throws(
    () => new AutonomousRunner({ pipeline: createDecisionEngine() }),
    /client.*symbols|symbols.*client/,
    'neither client nor symbols must throw',
  );
});

test('the runner starts, ticks and stops', async () => {
  const { runner } = rig();
  // start() fires an immediate cycle, so await that one rather than racing it
  // with a second call — overlapping cycles are deliberately refused.
  const cycles = [];
  runner.on('cycle', (r) => cycles.push(r));
  runner.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  runner.stop();

  assert.equal(runner.running, false);
  assert.equal(cycles.length, 1, 'the immediate cycle ran');
  assert.equal(cycles[0].ok, true);
  assert.equal(cycles[0].symbols, 1);
  assert.ok(cycles[0].durationMs >= 0);
});

test('overlapping cycles are refused rather than run twice', async () => {
  const { pipeline, runner } = rig();
  pipeline.fetchSymbol = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { candles: candles(UP), book: BOOK, dataAgeMs: 100 };
  };
  const first = runner.cycle();
  const second = await runner.cycle();
  assert.equal(second, null, 'a concurrent call returns the previous result, not a new cycle');
  await first;
});

/* ── The kill switch, mid-run ────────────────────────────────────────────── */

test('engaging the kill switch mid-run stops the very next cycle', async () => {
  const { runner, killSwitch, orders } = rig();

  const first = await runner.cycle();
  assert.equal(first.ranked[0].action, 'LONG');
  assert.equal(orders.length, 1, 'first cycle traded');

  killSwitch.engage('operator test');
  const second = await runner.cycle();

  assert.equal(second.ranked[0].action, 'NO_TRADE');
  assert.match(second.ranked[0].reason, /kill switch: operator test/);
  assert.equal(second.acted, null, 'nothing may be acted on while killed');
  assert.equal(orders.length, 1, 'no additional order was sent');
});

test('resuming the kill switch lets trading continue', async () => {
  const { runner, killSwitch } = rig();
  killSwitch.engage('halt');
  assert.equal((await runner.cycle()).ranked[0].action, 'NO_TRADE');
  killSwitch.resume('clear');
  assert.equal((await runner.cycle()).ranked[0].action, 'LONG');
});

/* ── Failure isolation ───────────────────────────────────────────────────── */

test('a cycle failure is reported, never thrown', async () => {
  const { pipeline } = rig();
  const runner = new AutonomousRunner({ pipeline, symbols: ['BTCINR'] });
  pipeline.fetchSymbol = async () => { throw new Error('upstream gone'); };

  const r = await runner.cycle();
  assert.equal(r.ok, true, 'a data failure is handled inside evaluate');
  assert.match(r.ranked[0].reason, /market data unavailable: upstream gone/);
  assert.equal(runner.errors, 0, 'handled internally, so not counted as an error');
});

test('a hard failure still returns a result instead of throwing', async () => {
  const { pipeline } = rig();
  const runner = new AutonomousRunner({ pipeline, symbols: ['BTCINR'] });
  pipeline.ai = { decide: () => { throw new Error('model exploded'); } };

  const r = await runner.cycle();
  assert.equal(r.ok, true, 'the cycle guard catches it');
  assert.match(r.ranked[0].reason, /evaluation failed: model exploded/);
});

test('an empty universe reports an error rather than silently doing nothing', async () => {
  const { pipeline } = rig();
  const runner = new AutonomousRunner({ pipeline, symbols: ['BTCINR'] });
  runner.symbols = [];
  const errors = [];
  runner.on('error', (e) => errors.push(e.message));

  const r = await runner.cycle();
  assert.equal(r.ok, false);
  assert.match(r.error, /no symbols to scan/);
  assert.equal(errors.length, 1);
});

/* ── Exposure actually accumulates across cycles ─────────────────────────── */

test('repeated entries on one symbol accumulate into exposure that gets capped', async () => {
  // A single symbol re-entered repeatedly grows ONE gateway position, so
  // maxOpenPositions never trips — the limit that has to catch this is account
  // exposure. At the default 200% cap, each ~100% notional entry means the
  // third must be refused. Before the gateway's book was reported to the risk
  // engine this stacked without bound.
  const { runner, gateway } = rig();

  const a = await runner.cycle();
  assert.equal(a.ranked[0].action, 'LONG', 'first entry opens');
  assert.equal(simulatedPositions(gateway).length, 1, 'the gateway sees its own fill');

  const b = await runner.cycle();
  assert.equal(b.ranked[0].action, 'LONG', 'second entry adds to it');

  const c = await runner.cycle();
  assert.equal(c.ranked[0].action, 'NO_TRADE', 'the third is refused');
  assert.match(c.ranked[0].reason, /exposure/i);
});

/* ── Account reading never guesses ───────────────────────────────────────── */

test('readEquity picks a recognised field and says which one', () => {
  const r = readEquity([{ equity: '12345.67', other: 1 }]);
  assert.equal(r.value, 12345.67);
  assert.equal(r.source, 'equity');
  assert.equal(r.reason, null);
});

test('readEquity refuses to guess when the shape is unrecognised', () => {
  const r = readEquity({ somethingUnexpected: 999 });
  assert.equal(r.value, 0, 'an unrecognised shape must not produce a balance');
  assert.equal(r.source, null);
  assert.match(r.reason, /no recognised equity field/);
  assert.match(r.reason, /somethingUnexpected/, 'the reason names the keys it did see');
});

test('normalisePositions derives notional and a correlation group', () => {
  const rows = normalisePositions([{ symbol: 'BTCINR', amount: 0.02, entryPrice: 7_000_000, side: 'BUY' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notional, 140_000);
  assert.equal(rows[0].side, 'BUY');
  assert.equal(rows[0].correlationGroup, 'INR');
});

test('simulatedPositions reflects gateway fills and ignores flat symbols', () => {
  const gateway = new OrderGateway({ priceSource: () => 7_000_000 });
  assert.deepEqual(simulatedPositions(gateway), []);
  gateway.positions.set('BTCINR', { symbol: 'BTCINR', qty: 0.01, avgPrice: 7_000_000 });
  gateway.positions.set('ETHINR', { symbol: 'ETHINR', qty: 0, avgPrice: 0 });
  const rows = simulatedPositions(gateway);
  assert.equal(rows.length, 1, 'the flat symbol is excluded');
  assert.equal(rows[0].side, 'LONG');
  assert.equal(rows[0].notional, 70_000);
});

/* ── Factory guardrails ──────────────────────────────────────────────────── */

test('the factory refuses a paper balance alongside live trading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-factory-'));
  try {
    const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
    assert.throws(
      () => buildAutonomous({
        client: {},
        config: { allowLive: true },
        flags: { live: true, paperEquity: 100000, auditFile: join(dir, 'audit.jsonl') },
        feed,
        feedMode: 'live',
      }),
      /paperEquity cannot be combined with live trading/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the factory defaults to evaluation only, with live trading blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-factory-'));
  try {
    const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
    const ai = buildAutonomous({
      client: {},
      config: {},
      flags: { auditFile: join(dir, 'audit.jsonl') },
      feed,
      feedMode: 'demo',
    });
    assert.equal(ai.gateway.mode, 'dry-run');
    assert.equal(ai.allowLive, false);
    assert.equal(ai.hasCredentials, false);
    assert.equal(ai.permissions.can('autonomousEntries'), false, 'execution is opt-in');
    assert.equal(ai.permissions.can('withdrawal'), false, 'withdrawals stay forbidden');
    ai.killSwitch.removeAllListeners();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a paper balance is labelled as paper, never as a real one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-factory-'));
  try {
    const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
    const ai = buildAutonomous({
      client: {},
      config: {},
      flags: { auditFile: join(dir, 'audit.jsonl'), paperEquity: 50_000 },
      feed,
      feedMode: 'demo',
    });
    const account = await ai.fetchAccount();
    assert.equal(account.equity, 50_000);
    assert.match(ai.accountState.equitySource, /paper/);
    ai.killSwitch.removeAllListeners();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without credentials the account reports zero equity and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-factory-'));
  try {
    const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
    const ai = buildAutonomous({
      client: {},
      config: {},
      flags: { auditFile: join(dir, 'audit.jsonl') },
      feed,
      feedMode: 'demo',
    });
    const account = await ai.fetchAccount();
    assert.equal(account.equity, 0, 'a missing balance is zero, never invented');
    assert.match(ai.accountState.lastError, /no API credentials/);
    ai.killSwitch.removeAllListeners();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pipeline explains a missing balance instead of throwing', async () => {
  const { pipeline } = rig({ equity: 0 });
  const trace = await pipeline.evaluate('BTCINR');
  assert.equal(trace.action, 'NO_TRADE');
  assert.equal(trace.stage, 'sizing');
  assert.match(trace.reasons[0], /no account equity available/);
  // The model still had its say; the block came later and is attributable.
  assert.equal(trace.decision.direction, 'LONG');
});
