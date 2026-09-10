/**
 * Technical indicators, implemented on plain arrays of candle objects
 * (`{ t, open, high, low, close, volume }`).
 *
 * No dependencies, and every function returns an array aligned index-for-index
 * with its input, using `null` for positions where the value is not yet defined.
 * That alignment matters: a strategy comparing `fast[i]` against `slow[i]` needs
 * both series to refer to the same candle.
 */

/**
 * Simple moving average.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function sma(values, period) {
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * Seeding this way (rather than with the first raw value) removes the startup
 * bias that would otherwise make the first few readings unreliable — important
 * because crossovers are detected off these early values.
 *
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function ema(values, period) {
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index, using Wilder's smoothing.
 * @param {number[]} values
 * @param {number} [period]
 * @returns {(number|null)[]}
 */
export function rsi(values, period = 14) {
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

/** Average true range (Wilder). Useful for sizing stops against volatility. */
export function atr(candles, period = 14) {
  assertPeriod(period);
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)),
    );
  }

  let prev = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Highest high / lowest low over a rolling window — the Donchian channel used by
 * breakout strategies.
 * @param {number[]} values
 * @param {number} period
 * @returns {{highest:(number|null)[], lowest:(number|null)[]}}
 */
export function rollingExtremes(values, period) {
  assertPeriod(period);
  const highest = new Array(values.length).fill(null);
  const lowest = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] > hi) hi = values[j];
      if (values[j] < lo) lo = values[j];
    }
    highest[i] = hi;
    lowest[i] = lo;
  }
  return { highest, lowest };
}

/** Extract closes from candles, dropping any non-finite values. */
export function closes(candles) {
  return candles.map((c) => c.close);
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new TypeError(`period must be a positive integer, received ${period}`);
  }
}
