import { atr, closes, ema, rollingExtremes, rsi, sma } from '../strategy/indicators.js';

/**
 * Feature extraction for the AI decision engine.
 *
 * Everything here is computed from OHLCV + order book only, and every factor is
 * returned in a normalised, documented range so the scoring layer can combine
 * them without hidden magic. No factor is a prediction; each is a measurement.
 *
 * Conventions:
 *   - Momentum/trend factors are in **[-1, +1]**: +1 strongly bullish.
 *   - Volatility/liquidity factors are **absolute, non-negative**.
 *   - Anything that cannot be computed yet returns `null`, never 0 — a missing
 *     feature must not silently look like a neutral reading.
 */

/**
 * @typedef {object} Features
 * @property {number} trend          [-1,1] multi-period EMA alignment
 * @property {number} momentum       [-1,1] rate of change, volatility-normalised
 * @property {number} rsi01          [0,1]  RSI scaled to 0..1
 * @property {number} volatilityPct  annualised-ish % per bar
 * @property {number|null} atrPct    ATR as % of price
 * @property {number} rangePosition  [0,1] where price sits in the Donchian range
 * @property {number|null} breakout  [-1,1] proximity/strength of a channel break
 * @property {number|null} reversal  [-1,1] mean-reversion pressure
 * @property {number|null} bookImbalance [-1,1] bid/ask depth imbalance
 * @property {number|null} spreadBps  spread in basis points
 * @property {number|null} liquidityScore [0,1] depth relative to a reference
 * @property {number} volumeTrend    ratio of recent volume to its average
 * @property {number} candleCount
 */

/**
 * Compute the full feature vector for one symbol.
 *
 * @param {object} args
 * @param {Array} args.candles   ascending OHLCV, closed candles only
 * @param {{bids:Array, asks:Array}} [args.book]
 * @param {object} [args.opts]
 * @returns {Features}
 */
export function extractFeatures({ candles, book, opts = {} }) {
  const {
    trendFast = 9,
    trendSlow = 21,
    trendAnchor = 50,
    momentumPeriod = 12,
    rsiPeriod = 14,
    atrPeriod = 14,
    channelPeriod = 20,
  } = opts;

  const values = closes(candles);
  const n = values.length;
  const empty = {
    trend: null, momentum: null, rsi01: null, volatilityPct: null, atrPct: null,
    rangePosition: null, breakout: null, reversal: null, bookImbalance: null,
    spreadBps: null, liquidityScore: null, volumeTrend: null, candleCount: n,
  };
  if (n < trendSlow + 2) return empty;

  const fast = ema(values, trendFast);
  const slow = ema(values, trendSlow);
  const anchor = n >= trendAnchor ? ema(values, trendAnchor) : null;
  const last = values[n - 1];

  // ── Trend: alignment of the EMA stack, measured in ATR units so a strong
  //    trend in a quiet market and a weak trend in a wild one compare fairly.
  const atrSeries = atr(candles, atrPeriod);
  const atrNow = atrSeries[n - 1];
  const atrPct = atrNow && last ? (atrNow / last) * 100 : null;

  let trend = null;
  if (fast[n - 1] !== null && slow[n - 1] !== null) {
    const spread = (fast[n - 1] - slow[n - 1]) / (atrNow || last * 0.01);
    trend = clamp(spread / 2, -1, 1);
    // Anchor confirmation: price above/below the long EMA reinforces direction.
    if (anchor && anchor[n - 1] !== null) {
      const above = last > anchor[n - 1] ? 0.15 : -0.15;
      trend = clamp(trend + above, -1, 1);
    }
  }

  // ── Momentum: volatility-normalised rate of change. Dividing by ATR keeps a
  //    2% move in BTC comparable to a 2% move in a small-cap.
  let momentum = null;
  if (n > momentumPeriod && atrNow > 0) {
    const roc = last - values[n - 1 - momentumPeriod];
    momentum = clamp(roc / (atrNow * 3), -1, 1);
  }

  // ── RSI
  const rsiSeries = rsi(values, rsiPeriod);
  const rsiNow = rsiSeries[n - 1];
  const rsi01 = rsiNow === null ? null : rsiNow / 100;

  // ── Volatility: mean absolute bar return, as a percentage.
  let volatilityPct = null;
  if (n > 20) {
    let sum = 0;
    let count = 0;
    for (let i = n - 20; i < n; i++) {
      if (values[i - 1] > 0) {
        sum += Math.abs(values[i] / values[i - 1] - 1);
        count++;
      }
    }
    volatilityPct = count ? (sum / count) * 100 : null;
  }

  // ── Channel position and breakout strength
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const { highest, lowest } = rollingExtremes(highs, channelPeriod);
  const { lowest: lowCh } = rollingExtremes(lows, channelPeriod);
  const hi = highest[n - 1];
  const lo = lowCh[n - 1];
  let rangePosition = null;
  let breakout = null;
  if (hi !== null && lo !== null && hi > lo) {
    rangePosition = (last - lo) / (hi - lo);
    // Breakout = how far past the *previous* channel edge price has moved,
    // measured in ATR. Uses the prior bar's channel so the current bar's own
    // high cannot create the breakout it is being scored on.
    const prevHi = highest[n - 2];
    const prevLo = lowCh[n - 2];
    if (prevHi !== null && prevLo !== null && atrNow > 0) {
      if (last > prevHi) breakout = clamp((last - prevHi) / atrNow, 0, 1);
      else if (last < prevLo) breakout = -clamp((prevLo - last) / atrNow, 0, 1);
      else breakout = 0;
    }
  }

  // ── Mean-reversion pressure: distance from the slow EMA, in ATR, inverted.
  let reversal = null;
  if (slow[n - 1] !== null && atrNow > 0) {
    const z = (last - slow[n - 1]) / atrNow;
    reversal = clamp(-z / 2, -1, 1);
  }

  // ── Volume trend: last 5 bars vs the trailing average.
  let volumeTrend = null;
  if (n > 25) {
    const vols = candles.map((c) => c.volume);
    const recent = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const base = vols.slice(-25, -5).reduce((a, b) => a + b, 0) / 20;
    volumeTrend = base > 0 ? recent / base : null;
  }

  return {
    ...empty,
    trend,
    momentum,
    rsi01,
    volatilityPct,
    atrPct,
    rangePosition,
    breakout,
    reversal,
    volumeTrend,
    candleCount: n,
    ...extractBookFeatures(book),
  };
}

/**
 * Order-book derived factors. Returns nulls when no book is supplied so the
 * caller can distinguish "no data" from "balanced book".
 */
export function extractBookFeatures(book) {
  const out = { bookImbalance: null, spreadBps: null, liquidityScore: null };
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  if (!bids.length || !asks.length) return out;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  if (!(bestBid > 0) || !(bestAsk > 0)) return out;

  const mid = (bestBid + bestAsk) / 2;
  out.spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  // Depth-weighted imbalance across the visible levels.
  const bidDepth = bids.reduce((a, [, q]) => a + Number(q), 0);
  const askDepth = asks.reduce((a, [, q]) => a + Number(q), 0);
  const total = bidDepth + askDepth;
  if (total > 0) out.bookImbalance = (bidDepth - askDepth) / total;

  // Liquidity: notional depth within 25bps of mid, mapped through a saturating
  // curve. The 5_000_000 INR reference is arbitrary but documented, and the
  // score is only ever used *relative* to other symbols in the same scan.
  const notionalWithin = (levels) =>
    levels.reduce((acc, [p, q]) => {
      const dist = Math.abs(Number(p) - mid) / mid;
      return dist <= 0.0025 ? acc + Number(p) * Number(q) : acc;
    }, 0);
  const nearNotional = notionalWithin(bids) + notionalWithin(asks);
  out.liquidityScore = nearNotional / (nearNotional + 5_000_000);

  return out;
}

/**
 * Classify the market regime from the feature vector.
 *
 * Strategy selection depends on this (§16): trend strategies in trends,
 * mean-reversion in ranges, reduced size in high volatility, and NO TRADE when
 * the picture is genuinely unclear.
 *
 * @param {Features} f
 * @returns {{regime:string, trending:boolean, highVol:boolean, uncertain:boolean, reason:string}}
 */
export function classifyRegime(f) {
  if (f.trend === null || f.volatilityPct === null) {
    return { regime: 'UNCERTAIN', trending: false, highVol: false, uncertain: true, reason: 'insufficient history' };
  }

  const vol = f.volatilityPct;
  const highVol = vol > 1.2;
  const lowVol = vol < 0.25;
  const absTrend = Math.abs(f.trend);

  // Volatility dominates: in a wild tape, direction is unreliable and size must
  // come down regardless of how clean the trend looks.
  if (vol > 2.0) {
    return { regime: 'HIGH_VOLATILITY', trending: false, highVol: true, uncertain: false, reason: `volatility ${vol.toFixed(2)}%/bar` };
  }

  if (absTrend >= 0.45) {
    if (f.trend > 0) {
      return { regime: absTrend >= 0.7 ? 'STRONG_BULL' : 'WEAK_BULL', trending: true, highVol, uncertain: false, reason: `trend +${f.trend.toFixed(2)}` };
    }
    return { regime: absTrend >= 0.7 ? 'STRONG_BEAR' : 'WEAK_BEAR', trending: true, highVol, uncertain: false, reason: `trend ${f.trend.toFixed(2)}` };
  }

  // Breakout takes priority over "sideways" when price has actually left the range.
  if (f.breakout !== null && Math.abs(f.breakout) >= 0.5) {
    return {
      regime: f.breakout > 0 ? 'BREAKOUT' : 'BREAKDOWN',
      trending: true,
      highVol,
      uncertain: false,
      reason: `channel break ${f.breakout.toFixed(2)} ATR`,
    };
  }

  if (lowVol && absTrend < 0.2) {
    return { regime: 'LOW_VOLATILITY', trending: false, highVol: false, uncertain: false, reason: `volatility ${vol.toFixed(2)}%/bar, trend flat` };
  }

  if (absTrend < 0.2) {
    return { regime: 'SIDEWAYS', trending: false, highVol, uncertain: false, reason: `trend ${f.trend.toFixed(2)} inside channel` };
  }

  return { regime: 'UNCERTAIN', trending: false, highVol, uncertain: true, reason: `trend ${f.trend.toFixed(2)} ambiguous` };
}

/** Clamp to a range, tolerating null. */
function clamp(v, lo, hi) {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export { sma };
