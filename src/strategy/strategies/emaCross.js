import { closes, ema } from '../indicators.js';

/**
 * EMA crossover — the reference strategy, and the template for writing others.
 *
 * Goes long when the fast EMA crosses above the slow EMA and flat/short when it
 * crosses back below. A crossover is detected only at the moment of the cross
 * (previous bar fast <= slow, current bar fast > slow), not while the condition
 * merely holds — otherwise the strategy would re-enter on every bar of a trend
 * and churn fees.
 *
 * Strategy contract, implemented here and consumed by `StrategyEngine`:
 *
 *   `name`        string label
 *   `params`      the configuration it was built with
 *   `onCandles({candles, ctx}) -> { action, amount?, reason, ... } | null`
 *
 * `action` is `'BUY' | 'SELL' | 'CLOSE' | 'HOLD'`.
 */
export function createEmaCrossStrategy(params = {}) {
  const {
    fastPeriod = 9,
    slowPeriod = 21,
    amount = 0.001,
    /** Enter short on a bearish cross; otherwise just flatten. */
    allowShort = false,
    /** Require the two EMAs to be at least this far apart before acting. */
    minSeparationPct = 0,
  } = params;

  if (fastPeriod >= slowPeriod) {
    throw new TypeError(`fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`);
  }

  return {
    name: `ema-cross(${fastPeriod},${slowPeriod})`,
    params: { fastPeriod, slowPeriod, amount, allowShort, minSeparationPct },

    /**
     * @param {{candles:Array, ctx:object}} args
     * @returns {{action:string, amount?:number, reason:string, fast?:number, slow?:number}|null}
     */
    onCandles({ candles, ctx }) {
      const values = closes(candles);
      const fast = ema(values, fastPeriod);
      const slow = ema(values, slowPeriod);

      const i = values.length - 1;
      if (i < 1) return hold('not enough candles');
      const f1 = fast[i];
      const s1 = slow[i];
      const f0 = fast[i - 1];
      const s0 = slow[i - 1];
      if (f1 === null || s1 === null || f0 === null || s0 === null) {
        return hold(`warming up (need ${slowPeriod} candles, have ${values.length})`);
      }

      const separationPct = (Math.abs(f1 - s1) / s1) * 100;
      const crossedUp = f0 <= s0 && f1 > s1;
      const crossedDown = f0 >= s0 && f1 < s1;

      if (crossedUp && separationPct >= minSeparationPct) {
        return {
          action: 'BUY',
          amount,
          reason: `EMA${fastPeriod} crossed above EMA${slowPeriod} (${f1.toFixed(2)} > ${s1.toFixed(2)})`,
          fast: f1,
          slow: s1,
        };
      }

      if (crossedDown && separationPct >= minSeparationPct) {
        return {
          action: allowShort ? 'SELL' : 'CLOSE',
          amount,
          reason: allowShort
            ? `EMA${fastPeriod} crossed below EMA${slowPeriod} — going short`
            : `EMA${fastPeriod} crossed below EMA${slowPeriod} — flattening`,
          fast: f1,
          slow: s1,
        };
      }

      return hold(
        `no cross (fast ${f1.toFixed(2)} vs slow ${s1.toFixed(2)}, position ${ctx?.positionQty ?? 0})`,
        f1,
        s1,
      );
    },
  };
}

function hold(reason, fast, slow) {
  return { action: 'HOLD', reason, fast, slow };
}
