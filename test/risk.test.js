import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_LIMITS, RiskEngine } from '../src/risk/engine.js';
import { KillSwitch } from '../src/risk/killswitch.js';
import { projectTrade } from '../src/costs/engine.js';

/** A proposal that clears every default limit. */
function goodProposal(overrides = {}) {
  return projectTrade({
    direction: 'LONG',
    entryPrice: 7_000_000,
    quantity: 0.002,
    leverage: 3,
    exitPrice: 7_200_000,
    stopLossPrice: 6_900_000,
    ...overrides,
  });
}

const healthyAccount = {
  equity: 100_000,
  openPositions: [],
  dailyPnlPct: 0,
  weeklyPnlPct: 0,
  drawdownPct: 0,
  consecutiveLosses: 0,
  dataAgeMs: 100,
  apiHealthy: true,
};

/* ── Approval ────────────────────────────────────────────────────────────── */

test('a well-formed trade within all limits is approved', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({ proposal: goodProposal(), context: healthyAccount });
  assert.equal(v.approved, true, v.reason);
  assert.equal(v.code, 'APPROVED');
  assert.ok(v.checks.every((c) => c.ok));
});

test('every check is recorded, pass or fail', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({ proposal: goodProposal(), context: healthyAccount });
  const codes = v.checks.map((c) => c.code);
  for (const expected of ['DATA_FRESH', 'API_HEALTH', 'DAILY_LOSS', 'LEVERAGE', 'NET_EDGE', 'RISK_REWARD']) {
    assert.ok(codes.includes(expected), `missing check ${expected}`);
  }
});

/* ── The Risk Engine outranks the AI ─────────────────────────────────────── */

test('the kill switch rejects even a perfect trade', () => {
  const risk = new RiskEngine();
  risk.halt('operator pressed stop');
  const v = risk.evaluate({ proposal: goodProposal(), context: healthyAccount });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'HALTED');
  assert.match(v.reason, /operator pressed stop/);
});

test('stale market data blocks a trade', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({
    proposal: goodProposal(),
    context: { ...healthyAccount, dataAgeMs: 120_000 },
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'DATA_FRESH');
});

test('an unhealthy API blocks a trade', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({ proposal: goodProposal(), context: { ...healthyAccount, apiHealthy: false } });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'API_HEALTH');
});

test('the daily loss limit halts new entries', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({
    proposal: goodProposal(),
    context: { ...healthyAccount, dailyPnlPct: -4 },
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'DAILY_LOSS');
});

test('consecutive losses halt new entries', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({
    proposal: goodProposal(),
    context: { ...healthyAccount, consecutiveLosses: 3 },
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'CONSECUTIVE_LOSSES');
});

test('excessive leverage is rejected', () => {
  const risk = new RiskEngine({ maxLeverage: 5 });
  const v = risk.evaluate({ proposal: goodProposal({ leverage: 20 }), context: healthyAccount });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'LEVERAGE');
});

test('a position too large for the account is rejected', () => {
  const risk = new RiskEngine();
  // 10 BTC at 7m = 70m notional on 100k equity
  const v = risk.evaluate({
    proposal: goodProposal({ quantity: 10, exitPrice: 7_200_000 }),
    context: healthyAccount,
  });
  assert.equal(v.approved, false);
  assert.ok(['POSITION_SIZE', 'PAIR_EXPOSURE', 'ACCOUNT_EXPOSURE'].includes(v.code));
});

test('too many open positions is rejected', () => {
  const risk = new RiskEngine({ maxOpenPositions: 2 });
  const v = risk.evaluate({
    proposal: goodProposal(),
    context: {
      ...healthyAccount,
      openPositions: [{ notional: 1000 }, { notional: 1000 }],
    },
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'OPEN_POSITIONS');
});

test('correlated concentration is rejected', () => {
  const risk = new RiskEngine({ maxCorrelatedPositions: 1 });
  const v = risk.evaluate({
    proposal: goodProposal(),
    context: {
      ...healthyAccount,
      openPositions: [{ notional: 1000, correlationGroup: 'INR:major' }],
      correlationGroup: 'INR:major',
    },
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'CORRELATION');
});

test('a trade whose net edge does not clear costs is rejected', () => {
  const risk = new RiskEngine({ minNetEdgePct: 0.5 });
  // Exit barely above entry: gross profit will not cover fees + slippage.
  const v = risk.evaluate({
    proposal: goodProposal({ exitPrice: 7_000_500 }),
    context: healthyAccount,
  });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'NET_EDGE', 'this is the "don\'t trade for nothing" gate');
});

test('a poor risk/reward is rejected', () => {
  const risk = new RiskEngine({ minRiskReward: 5 });
  const v = risk.evaluate({ proposal: goodProposal(), context: healthyAccount });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'RISK_REWARD');
});

test('a wide spread is rejected', () => {
  const risk = new RiskEngine({ maxSpreadBps: 5 });
  const proposal = goodProposal();
  proposal.execution.spreadBps = 40;
  const v = risk.evaluate({ proposal, context: healthyAccount });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'SPREAD');
});

test('insufficient equity is rejected before sizing', () => {
  const risk = new RiskEngine();
  const v = risk.evaluate({ proposal: goodProposal(), context: { ...healthyAccount, equity: 0 } });
  assert.equal(v.approved, false);
  assert.equal(v.code, 'EQUITY');
});

test('limits are configurable and override the defaults', () => {
  const strict = new RiskEngine({ maxLeverage: 2 });
  assert.equal(strict.limits.maxLeverage, 2);
  assert.equal(strict.limits.maxDailyLossPct, DEFAULT_RISK_LIMITS.maxDailyLossPct, 'others keep defaults');
});

test('status summarises recent verdicts', () => {
  const risk = new RiskEngine();
  risk.evaluate({ proposal: goodProposal(), context: healthyAccount });
  risk.evaluate({ proposal: goodProposal(), context: { ...healthyAccount, apiHealthy: false } });
  const s = risk.status();
  assert.equal(s.evaluated, 2);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.lastCode, 'API_HEALTH');
});

/* ── Kill switch ─────────────────────────────────────────────────────────── */

test('the kill switch latches until explicitly resumed', () => {
  const ks = new KillSwitch();
  assert.equal(ks.blocked, false);

  assert.equal(ks.engage('user pressed STOP TRADING'), true);
  assert.equal(ks.blocked, true);
  assert.match(ks.reason, /kill switch/);

  // Idempotent
  assert.equal(ks.engage('again'), false);
  assert.equal(ks.blocked, true);

  assert.equal(ks.resume('operator reviewed positions'), true);
  assert.equal(ks.blocked, false);
});

test('engaging or resuming requires a reason', () => {
  const ks = new KillSwitch();
  assert.throws(() => ks.engage(''), /reason is required/);
  ks.engage('test');
  assert.throws(() => ks.resume(''), /reason is required/);
});

test('the circuit breaker trips automatically and latches', () => {
  const ks = new KillSwitch();
  assert.equal(ks.checkHealth({ apiHealthy: false }), true);
  assert.equal(ks.blocked, true);
  assert.ok(ks.status().breakerReasons.includes('API_FAILURE'));

  // Does not self-clear when the condition goes away.
  assert.equal(ks.checkHealth({ apiHealthy: true }), true);
  assert.equal(ks.blocked, true, 'a silent recovery would hide the fault');

  ks.resetBreaker();
  assert.equal(ks.blocked, false);
});

test('stale data trips the breaker', () => {
  const ks = new KillSwitch();
  ks.checkHealth({ dataAgeMs: 999_999, maxDataAgeMs: 30_000 });
  assert.ok(ks.status().breakerReasons.includes('STALE_DATA'));
});

test('an abnormal price move trips the breaker', () => {
  const ks = new KillSwitch();
  ks.checkHealth({ priceMovePct: 42, maxPriceMovePct: 15 });
  assert.ok(ks.status().breakerReasons.includes('PRICE_ANOMALY'));
});

test('repeated order failures trip the breaker', () => {
  const ks = new KillSwitch();
  ks.checkHealth({ consecutiveOrderFailures: 3, maxConsecutiveOrderFailures: 3 });
  assert.ok(ks.status().breakerReasons.includes('ORDER_FAILURES'));
});

test('a manual kill switch survives a breaker reset', () => {
  const ks = new KillSwitch();
  ks.engage('manual stop');
  ks.trip('API_FAILURE', 'test');
  ks.resetBreaker();
  assert.equal(ks.blocked, true, 'the human decision must not be cleared by a machine reset');
  assert.match(ks.reason, /kill switch/);
});

test('kill switch events are recorded for the audit trail', () => {
  const ks = new KillSwitch();
  ks.engage('stop');
  ks.trip('STALE_DATA', 'x');
  ks.resume('go');
  const types = ks.status().recentEvents.map((e) => e.type);
  assert.deepEqual(types, ['KILL_SWITCH_ENGAGED', 'BREAKER_TRIPPED', 'KILL_SWITCH_RESUMED']);
});
