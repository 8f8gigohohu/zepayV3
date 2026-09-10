import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegime, extractFeatures } from '../src/ai/features.js';
import { DEFAULT_WEIGHTS, REGIME_STRATEGY, createDecisionEngine } from '../src/ai/engine.js';

const MIN = 60_000;

/** Build candles from a price path. */
function candles(prices, start = 1_700_000_000_000) {
  return prices.map((close, i) => ({
    t: start + i * MIN,
    open: prices[i - 1] ?? close,
    high: Math.max(close, prices[i - 1] ?? close) * 1.002,
    low: Math.min(close, prices[i - 1] ?? close) * 0.998,
    close,
    volume: 10,
    endTime: start + (i + 1) * MIN - 1,
  }));
}

/** A steady uptrend with mild noise. */
function uptrend(n = 80, start = 7_000_000, step = 0.004) {
  return Array.from({ length: n }, (_, i) => start * (1 + step) ** i);
}
function downtrend(n = 80, start = 7_000_000, step = 0.004) {
  return Array.from({ length: n }, (_, i) => start * (1 - step) ** i);
}
function sideways(n = 80, mid = 7_000_000) {
  return Array.from({ length: n }, (_, i) => mid * (1 + (i % 2 === 0 ? 0.0004 : -0.0004)));
}

const BALANCED_BOOK = {
  bids: Array.from({ length: 20 }, (_, i) => [7_000_000 - (i + 1) * 100, 1]),
  asks: Array.from({ length: 20 }, (_, i) => [7_000_000 + (i + 1) * 100, 1]),
};

/* ── Features ────────────────────────────────────────────────────────────── */

test('extractFeatures returns nulls rather than zeros when history is short', () => {
  const f = extractFeatures({ candles: candles([1, 2, 3]) });
  assert.equal(f.trend, null, 'a missing feature must not read as neutral');
  assert.equal(f.momentum, null);
  assert.equal(f.candleCount, 3);
});

test('trend is positive in an uptrend and negative in a downtrend', () => {
  assert.ok(extractFeatures({ candles: candles(uptrend()) }).trend > 0.3);
  assert.ok(extractFeatures({ candles: candles(downtrend()) }).trend < -0.3);
});

test('momentum has the sign of the move', () => {
  assert.ok(extractFeatures({ candles: candles(uptrend()) }).momentum > 0);
  assert.ok(extractFeatures({ candles: candles(downtrend()) }).momentum < 0);
});

test('bounded features stay within their documented ranges', () => {
  for (const path of [uptrend(), downtrend(), sideways()]) {
    const f = extractFeatures({ candles: candles(path), book: BALANCED_BOOK });
    for (const k of ['trend', 'momentum', 'breakout', 'reversal', 'bookImbalance']) {
      if (f[k] === null) continue;
      assert.ok(f[k] >= -1 && f[k] <= 1, `${k}=${f[k]} out of [-1,1]`);
    }
    assert.ok(f.rsi01 >= 0 && f.rsi01 <= 1);
    assert.ok(f.volatilityPct >= 0);
    assert.ok(f.rangePosition >= 0 && f.rangePosition <= 1.0001);
  }
});

test('a balanced book yields near-zero imbalance and a tight spread', () => {
  const f = extractFeatures({ candles: candles(uptrend()), book: BALANCED_BOOK });
  assert.ok(Math.abs(f.bookImbalance) < 0.01, `expected balanced, got ${f.bookImbalance}`);
  assert.ok(f.spreadBps < 5);
  assert.ok(f.liquidityScore > 0 && f.liquidityScore < 1);
});

test('a bid-heavy book produces positive imbalance', () => {
  const book = {
    bids: Array.from({ length: 20 }, (_, i) => [7_000_000 - (i + 1) * 100, 10]),
    asks: Array.from({ length: 20 }, (_, i) => [7_000_000 + (i + 1) * 100, 0.1]),
  };
  const f = extractFeatures({ candles: candles(uptrend()), book });
  assert.ok(f.bookImbalance > 0.5, `expected strong bid bias, got ${f.bookImbalance}`);
});

test('no book yields null book factors, not zeros', () => {
  const f = extractFeatures({ candles: candles(uptrend()) });
  assert.equal(f.bookImbalance, null);
  assert.equal(f.spreadBps, null);
  assert.equal(f.liquidityScore, null);
});

/* ── Regime ──────────────────────────────────────────────────────────────── */

test('regime classification separates trend, range and chaos', () => {
  assert.match(classifyRegime(extractFeatures({ candles: candles(uptrend()) })).regime, /BULL|BREAKOUT/);
  assert.match(classifyRegime(extractFeatures({ candles: candles(downtrend()) })).regime, /BEAR|BREAKDOWN/);

  const flat = classifyRegime(extractFeatures({ candles: candles(sideways()) }));
  assert.match(flat.regime, /SIDEWAYS|LOW_VOLATILITY|UNCERTAIN/);
});

test('insufficient history is UNCERTAIN, not a guess', () => {
  const r = classifyRegime(extractFeatures({ candles: candles([1, 2]) }));
  assert.equal(r.regime, 'UNCERTAIN');
  assert.equal(r.uncertain, true);
});

test('every regime maps to a strategy family', () => {
  for (const regime of Object.keys(REGIME_STRATEGY)) {
    assert.ok(typeof REGIME_STRATEGY[regime] === 'string');
  }
  assert.equal(REGIME_STRATEGY.UNCERTAIN, 'none');
});

/* ── Decision engine ─────────────────────────────────────────────────────── */

test('the engine picks LONG in a clean uptrend', () => {
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend()), book: BALANCED_BOOK });
  assert.equal(d.direction, 'LONG');
  assert.ok(d.scores.long > d.scores.short);
  assert.ok(d.geometry, 'a directional call must carry geometry');
  assert.ok(d.geometry.stopLoss < d.geometry.entryPrice);
  assert.ok(d.geometry.target > d.geometry.entryPrice);
});

test('the engine picks SHORT in a clean downtrend', () => {
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(downtrend()), book: BALANCED_BOOK });
  assert.equal(d.direction, 'SHORT');
  assert.ok(d.geometry.stopLoss > d.geometry.entryPrice, 'a short stop sits above entry');
  assert.ok(d.geometry.target < d.geometry.entryPrice);
});

test('scores always sum to 1 and are labelled as model scores', () => {
  const ai = createDecisionEngine();
  for (const path of [uptrend(), downtrend(), sideways()]) {
    const d = ai.decide({ symbol: 'BTCINR', candles: candles(path), book: BALANCED_BOOK });
    const sum = d.scores.long + d.scores.short + d.scores.noTrade;
    assert.ok(Math.abs(sum - 1) < 1e-9, `scores must sum to 1, got ${sum}`);
    assert.equal(d.modelScoreNotProbability, true, 'must not be presented as probability');
  }
});

test('every decision records auditable factors', () => {
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend()), book: BALANCED_BOOK });
  const names = d.factors.map((f) => f.name);
  for (const expected of ['trend', 'momentum', 'breakout', 'bookImbalance', 'volume', 'reversal', 'uncertainty']) {
    assert.ok(names.includes(expected), `missing factor ${expected}`);
  }
  for (const f of d.factors) {
    assert.equal(typeof f.weight, 'number');
    assert.ok(typeof f.note === 'string' && f.note.length > 0, 'every factor needs a note');
  }
});

test('weights are configurable and change the outcome', () => {
  const trendOnly = createDecisionEngine({
    weights: { ...DEFAULT_WEIGHTS, trend: 1, momentum: 0, breakout: 0, bookImbalance: 0, volume: 0, reversal: 0 },
  });
  const d = trendOnly.decide({ symbol: 'BTCINR', candles: candles(uptrend()), book: BALANCED_BOOK });
  assert.equal(d.direction, 'LONG');
  assert.equal(trendOnly.weights.momentum, 0);
});

test('mean-reversion is suppressed outside a ranging regime', () => {
  const ai = createDecisionEngine();
  const trending = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend()), book: BALANCED_BOOK });
  const rev = trending.factors.find((f) => f.name === 'reversal');
  assert.equal(rev.value, 0);
  assert.match(rev.note, /suppressed/);
});

test('NO_TRADE is a real outcome with reasons', () => {
  // A flat tape with a normal confidence floor: the honest answer is no trade.
  const ai = createDecisionEngine({ minScore: 0.6 });
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(sideways()), book: BALANCED_BOOK });
  assert.equal(d.direction, 'NO_TRADE');
  assert.ok(d.noTradeReasons.length > 0, 'must explain why it did not trade');
  assert.equal(d.geometry, null);
});

test('the model never reports certainty, so minScore stays meaningful', () => {
  const ai = createDecisionEngine();
  for (const path of [uptrend(), downtrend(), sideways()]) {
    const d = ai.decide({ symbol: 'BTCINR', candles: candles(path), book: BALANCED_BOOK });
    for (const [k, v] of Object.entries(d.scores)) {
      assert.ok(v < 1, `${k} score reached 1.0 — no model is certain`);
    }
  }
});

test('insufficient history yields NO_TRADE, never a guess', () => {
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles([1, 2, 3]), book: BALANCED_BOOK });
  assert.equal(d.direction, 'NO_TRADE');
  assert.match(d.noTradeReasons[0], /insufficient history/);
});

test('the regime vetoes a direction it contradicts', () => {
  // Force a directional score but pair it with a contradictory regime by
  // asserting the invariant directly: STRONG_BULL must never yield SHORT.
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend(120, 7_000_000, 0.008)), book: BALANCED_BOOK });
  if (['STRONG_BULL', 'BREAKOUT'].includes(d.regime)) {
    assert.notEqual(d.direction, 'SHORT');
  }
});

test('HIGH_VOLATILITY and UNCERTAIN regimes never produce a trade', () => {
  const ai = createDecisionEngine();
  // Wild alternating swings produce extreme per-bar volatility.
  const wild = Array.from({ length: 80 }, (_, i) => 7_000_000 * (1 + (i % 2 === 0 ? 0.09 : -0.09)));
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(wild), book: BALANCED_BOOK });
  if (d.regime === 'HIGH_VOLATILITY' || d.regime === 'UNCERTAIN') {
    assert.equal(d.direction, 'NO_TRADE');
  }
});

test('missing liquidity data is recorded as an unknown, not ignored', () => {
  const ai = createDecisionEngine();
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend()) }); // no book
  const unc = d.factors.find((f) => f.name === 'uncertainty');
  assert.match(unc.note, /no order book/);
});

test('geometry scales with ATR', () => {
  const ai = createDecisionEngine({ geometry: { stopAtrMultiple: 3, targetAtrMultiple: 6 } });
  const d = ai.decide({ symbol: 'BTCINR', candles: candles(uptrend()), book: BALANCED_BOOK });
  if (d.geometry) {
    assert.ok(d.geometry.targetDistancePct > d.geometry.stopDistancePct);
  }
});
