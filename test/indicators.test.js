import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr, closes, ema, rollingExtremes, rsi, sma } from '../src/strategy/indicators.js';

const candle = (close, extra = {}) => ({ open: close, high: close, low: close, close, volume: 1, ...extra });

test('sma matches hand-computed values', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test('sma returns all null when there are fewer values than the period', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('sma of a constant series equals that constant', () => {
  assert.deepEqual(sma([7, 7, 7, 7], 2), [null, 7, 7, 7]);
});

test('ema is seeded with the SMA of the first period', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2, 'seed = SMA(1,2,3) = 2');
  // k = 2/(3+1) = 0.5 -> ema = 4*0.5 + 2*0.5 = 3
  assert.equal(out[3], 3);
  // ema = 5*0.5 + 3*0.5 = 4
  assert.equal(out[4], 4);
});

test('ema tracks a rising series above a lagging sma', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + i);
  const fast = ema(values, 5);
  const slow = sma(values, 20);
  assert.ok(fast.at(-1) > slow.at(-1), 'fast EMA should sit above the slow SMA in an uptrend');
});

test('ema and sma align index-for-index with their input', () => {
  const values = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(ema(values, 9).length, values.length);
  assert.equal(sma(values, 9).length, values.length);
});

test('rsi is 100 on a strictly rising series', () => {
  const out = rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14);
  assert.equal(out[14], 100);
  assert.equal(out.at(-1), 100);
});

test('rsi is 0 on a strictly falling series', () => {
  const out = rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14);
  assert.equal(out[14], 0);
});

test('rsi stays within 0-100 and is null before the warmup', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 10);
  const out = rsi(values, 14);
  assert.equal(out[13], null, 'undefined before period+1');
  for (const v of out.slice(14)) {
    assert.ok(v >= 0 && v <= 100, `rsi out of range: ${v}`);
  }
});

test('atr measures a candle range when price is flat', () => {
  const candles = Array.from({ length: 20 }, () => candle(100, { high: 102, low: 98 }));
  const out = atr(candles, 14);
  assert.equal(out[13], null);
  assert.equal(out[14], 4, 'true range is high-low = 4 when close is unchanged');
});

test('rollingExtremes tracks the window high and low', () => {
  const { highest, lowest } = rollingExtremes([5, 1, 9, 3, 7], 3);
  assert.deepEqual(highest, [null, null, 9, 9, 9]);
  assert.deepEqual(lowest, [null, null, 1, 1, 3]);
});

test('indicators reject an invalid period', () => {
  for (const fn of [sma, ema, rsi]) {
    assert.throws(() => fn([1, 2, 3], 0), TypeError);
    assert.throws(() => fn([1, 2, 3], 1.5), TypeError);
    assert.throws(() => fn([1, 2, 3], -2), TypeError);
  }
});

test('closes extracts the close series', () => {
  assert.deepEqual(closes([candle(1), candle(2), candle(3)]), [1, 2, 3]);
});
