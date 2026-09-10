import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KLINE_TIMEFRAMES,
  TIMEFRAME_MS,
  assertTimeframe,
  normalizeSymbol,
  parseKlineRow,
  splitSymbol,
  toDisplaySymbol,
} from '../src/core/symbols.js';
import { ValidationError } from '../src/core/errors.js';

test('normalizeSymbol converts every UI form to the API form', () => {
  for (const input of ['BTC-INR', 'btcinr', 'BTC_INR', 'btc inr', '  BTC-INR  ']) {
    assert.equal(normalizeSymbol(input), 'BTCINR', `input ${JSON.stringify(input)}`);
  }
});

test('normalizeSymbol handles quoted base assets', () => {
  assert.equal(normalizeSymbol('1000PEPE-INR'), '1000PEPEINR');
});

test('normalizeSymbol rejects empty and malformed input', () => {
  for (const bad of ['', '   ', null, undefined, 42, 'BTC/INR', 'BTC$INR']) {
    assert.throws(() => normalizeSymbol(bad), ValidationError, `expected rejection for ${bad}`);
  }
});

test('splitSymbol separates base and quote using known quotes', () => {
  assert.deepEqual(splitSymbol('BTCINR'), { base: 'BTC', quote: 'INR' });
  assert.deepEqual(splitSymbol('ETH-USDT'), { base: 'ETH', quote: 'USDT' });
  assert.deepEqual(splitSymbol('1000PEPEINR'), { base: '1000PEPE', quote: 'INR' });
});

test('splitSymbol prefers the longest matching quote', () => {
  assert.deepEqual(splitSymbol('XUSDT', ['INR', 'USDT']), { base: 'X', quote: 'USDT' });
});

test('splitSymbol returns null when no known quote matches', () => {
  assert.equal(splitSymbol('XYZ', ['INR', 'USDT']), null);
});

test('toDisplaySymbol produces the dashed UI form', () => {
  assert.equal(toDisplaySymbol('BTCINR'), 'BTC-INR');
  assert.equal(toDisplaySymbol('ETHUSDT'), 'ETH-USDT');
  assert.equal(toDisplaySymbol('XYZ'), 'XYZ', 'unknown quote falls back to the raw symbol');
});

test('assertTimeframe accepts every documented interval', () => {
  for (const tf of KLINE_TIMEFRAMES) assert.equal(assertTimeframe(tf), tf);
});

test('assertTimeframe rejects undocumented intervals', () => {
  // `interval`/`2m`/`1H` would be silently stripped or mis-handled server-side.
  for (const bad of ['2m', '1H', '45m', '', undefined]) {
    assert.throws(() => assertTimeframe(bad), ValidationError, `expected rejection for ${bad}`);
  }
});

test('every timeframe has a millisecond step for paging', () => {
  for (const tf of KLINE_TIMEFRAMES) {
    assert.ok(Number.isFinite(TIMEFRAME_MS[tf]), `missing TIMEFRAME_MS entry for ${tf}`);
    assert.ok(TIMEFRAME_MS[tf] > 0);
  }
});

test('parseKlineRow converts a positional row to a typed candle', () => {
  const row = [1612345678000, '5500000', '5600000', '5400000', '5550000', '10.5', 1612345738000];
  assert.deepEqual(parseKlineRow(row), {
    t: 1612345678000,
    open: 5500000,
    high: 5600000,
    low: 5400000,
    close: 5550000,
    volume: 10.5,
    endTime: 1612345738000,
  });
});

test('parseKlineRow tolerates non-numeric prices as NaN rather than throwing', () => {
  const row = [1, 'abc', '2', '0.5', '1.5', '3', 2];
  const c = parseKlineRow(row);
  assert.ok(Number.isNaN(c.open));
  assert.equal(c.high, 2);
});

test('parseKlineRow rejects malformed rows', () => {
  assert.equal(parseKlineRow(null), null);
  assert.equal(parseKlineRow([1, 2, 3]), null);
  assert.equal(parseKlineRow('nope'), null);
});
