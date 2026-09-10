import { classifyRegime, extractFeatures } from './features.js';

/**
 * AI decision engine.
 *
 * Produces **LONG / SHORT / NO_TRADE** for one symbol, with every contributing
 * factor recorded so a decision can be audited and replayed.
 *
 * ── ON THE WORD "AI" ──────────────────────────────────────────────────────
 * This is a deterministic, transparent scoring model — not an LLM and not a
 * guarantee. Its outputs are **model scores**, not real-world probabilities.
 * They are only meaningful relative to each other and to the thresholds you
 * configure, and they have no edge unless backtesting and paper trading on your
 * own data show one. The spec's own rule applies: never present a score as a
 * probability of profit.
 *
 * ── WEIGHTS ───────────────────────────────────────────────────────────────
 * Every weight is documented and configurable (§5). The defaults encode one
 * opinion: trend and momentum lead, order flow confirms, mean-reversion is
 * only trusted in a ranging regime, and uncertainty is penalised rather than
 * ignored. They are a starting point to be re-fit on your data, not a truth.
 */
export const DEFAULT_WEIGHTS = {
  trend: 0.30,
  momentum: 0.22,
  breakout: 0.16,
  bookImbalance: 0.10,
  volume: 0.08,
  // Mean-reversion is applied ONLY when the regime is ranging; in a trend it
  // would fight the dominant signal.
  reversal: 0.14,
  /** Penalty weight for genuine uncertainty; pushes mass toward NO_TRADE. */
  uncertainty: 1.0,
  /**
   * Irreducible uncertainty, always present.
   *
   * Without this floor a perfectly clean setup scores exactly 1.0, which is both
   * dishonest — no model is certain — and useless, because a score of 1.0 clears
   * any confidence threshold you could set. This keeps the maximum attainable
   * directional score below 1 so `minScore` remains a meaningful gate.
   */
  baselineUncertainty: 0.25,
  /** Sharpening factor converting the raw score into comparable scores. */
  sharpness: 3.0,
};

/** Which strategy family suits which regime (§16). */
export const REGIME_STRATEGY = {
  STRONG_BULL: 'trend-follow',
  WEAK_BULL: 'trend-follow',
  STRONG_BEAR: 'trend-follow',
  WEAK_BEAR: 'trend-follow',
  BREAKOUT: 'breakout',
  BREAKDOWN: 'breakout',
  SIDEWAYS: 'mean-reversion',
  LOW_VOLATILITY: 'mean-reversion',
  HIGH_VOLATILITY: 'volatility-reduced',
  UNCERTAIN: 'none',
};

/** ATR multiples for stop and target. Configurable, never hidden. */
export const DEFAULT_GEOMETRY = {
  stopAtrMultiple: 1.5,
  targetAtrMultiple: 3.0,
  defaultLeverage: 3,
  maxLeverage: 10,
};

export function createDecisionEngine({ weights = {}, geometry = {}, minScore = 0.5 } = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...weights };
  const G = { ...DEFAULT_GEOMETRY, ...geometry };

  return {
    name: 'zepay-decision-v1',
    weights: W,
    geometry: G,

    /**
     * Decide for one symbol.
     *
     * @param {object} args
     * @param {string} args.symbol
     * @param {Array} args.candles    closed candles, ascending
     * @param {{bids:Array, asks:Array}} [args.book]
     * @param {number} [args.minLiquidityScore]
     * @returns {object} decision
     */
    decide({ symbol, candles, book, minLiquidityScore = 0 }) {
      const features = extractFeatures({ candles, book });
      const regimeInfo = classifyRegime(features);
      const factors = [];
      const add = (name, value, weight, note) =>
        factors.push({ name, value, weight, contribution: value === null ? 0 : value * weight, note });

      // ── Missing data is a NO-TRADE condition, not a neutral reading.
      if (features.trend === null || features.momentum === null) {
        return noTrade(symbol, features, regimeInfo, factors, 'insufficient history to score');
      }

      // ── Directional evidence
      add('trend', features.trend, W.trend, 'EMA stack alignment in ATR units');
      add('momentum', features.momentum, W.momentum, 'volatility-normalised rate of change');
      add('breakout', features.breakout ?? 0, W.breakout, 'distance past the prior channel edge');
      add('bookImbalance', features.bookImbalance ?? 0, W.bookImbalance, 'bid/ask depth imbalance');

      // Volume confirms whichever way price is already moving.
      const dir = Math.sign(features.trend || features.momentum || 0);
      const volConfirm = features.volumeTrend === null ? 0 : dir * clamp01(features.volumeTrend - 1);
      add('volume', volConfirm, W.volume, 'recent volume vs trailing average');

      // Mean-reversion only counts in a ranging tape.
      const reversionActive = regimeInfo.regime === 'SIDEWAYS' || regimeInfo.regime === 'LOW_VOLATILITY';
      add('reversal', reversionActive ? (features.reversal ?? 0) : 0, W.reversal,
        reversionActive ? 'distance from slow EMA, inverted' : 'suppressed: regime is not ranging');

      const raw = factors.reduce((a, f) => a + f.contribution, 0);
      const score = clamp(raw, -1, 1);

      // ── Uncertainty: what we do NOT know. This is what makes NO_TRADE a real
      //    outcome rather than a residual.
      const unknowns = [];
      if (features.bookImbalance === null) unknowns.push('no order book');
      if (features.liquidityScore === null) unknowns.push('no liquidity measure');
      else if (features.liquidityScore < minLiquidityScore) unknowns.push('thin liquidity');
      if (features.spreadBps !== null && features.spreadBps > 25) unknowns.push('wide spread');
      if (regimeInfo.uncertain) unknowns.push(`regime ${regimeInfo.regime}`);
      if (features.volatilityPct !== null && features.volatilityPct > 2) unknowns.push('extreme volatility');
      if (features.volumeTrend !== null && features.volumeTrend < 0.5) unknowns.push('volume drying up');

      const uncertainty = clamp01(unknowns.length / 4);
      add('uncertainty', -uncertainty, W.uncertainty, unknowns.join(', ') || 'none identified');

      // ── Convert to comparable model scores. Positive raw favours LONG.
      const longRaw = Math.max(0, score) * W.sharpness;
      const shortRaw = Math.max(0, -score) * W.sharpness;
      const noTradeRaw =
        W.baselineUncertainty +
        uncertainty * W.uncertainty +
        (regimeInfo.regime === 'UNCERTAIN' ? 0.6 : 0);

      const total = longRaw + shortRaw + noTradeRaw;
      const scores = total > 0
        ? { long: longRaw / total, short: shortRaw / total, noTrade: noTradeRaw / total }
        : { long: 0, short: 0, noTrade: 1 };

      const strategy = REGIME_STRATEGY[regimeInfo.regime] ?? 'none';
      const lastPrice = candles.at(-1)?.close;
      const atrPct = features.atrPct ?? 0;
      const atrAbs = lastPrice ? (atrPct / 100) * lastPrice : 0;

      // ── Pick a direction only if it clears the confidence floor AND beats
      //    NO_TRADE. Otherwise the honest answer is NO_TRADE.
      let direction = 'NO_TRADE';
      if (scores.long >= minScore && scores.long > scores.noTrade && scores.long > scores.short) {
        direction = 'LONG';
      } else if (scores.short >= minScore && scores.short > scores.noTrade && scores.short > scores.long) {
        direction = 'SHORT';
      }

      // Regime veto: never trade a direction the regime contradicts, and never
      // trade at all in extreme volatility or genuine uncertainty.
      if (direction !== 'NO_TRADE') {
        if (regimeInfo.regime === 'UNCERTAIN') direction = 'NO_TRADE';
        if (regimeInfo.regime === 'HIGH_VOLATILITY') direction = 'NO_TRADE';
        if (direction === 'LONG' && ['STRONG_BEAR', 'BREAKDOWN'].includes(regimeInfo.regime)) direction = 'NO_TRADE';
        if (direction === 'SHORT' && ['STRONG_BULL', 'BREAKOUT'].includes(regimeInfo.regime)) direction = 'NO_TRADE';
      }

      const geometry = direction === 'NO_TRADE' ? null : buildGeometry({
        direction, entryPrice: lastPrice, atr: atrAbs, G,
      });

      const confidence = direction === 'NO_TRADE' ? scores.noTrade : Math.max(scores.long, scores.short);

      return {
        symbol,
        direction,
        scores,
        confidence,
        regime: regimeInfo.regime,
        regimeReason: regimeInfo.reason,
        strategy,
        features,
        factors,
        geometry,
        entryPrice: lastPrice ?? null,
        reasons: buildReasons(direction, factors, regimeInfo),
        noTradeReasons: direction === 'NO_TRADE'
          ? buildNoTradeReasons({ scores, unknowns, regimeInfo, minScore })
          : [],
        invalidation: geometry
          ? `invalidated if price crosses the stop at ${round(geometry.stopLoss)}`
          : 'no position proposed',
        modelScoreNotProbability: true,
      };
    },
  };
}

/** ATR-based stop/target geometry. */
function buildGeometry({ direction, entryPrice, atr, G }) {
  if (!(entryPrice > 0) || !(atr > 0)) return null;
  const sign = direction === 'LONG' ? 1 : -1;
  const stopLoss = entryPrice - sign * atr * G.stopAtrMultiple;
  const target = entryPrice + sign * atr * G.targetAtrMultiple;
  return {
    entryPrice,
    stopLoss: Math.max(0, stopLoss),
    target: Math.max(0, target),
    leverage: G.defaultLeverage,
    maxLeverage: G.maxLeverage,
    stopDistancePct: (Math.abs(entryPrice - stopLoss) / entryPrice) * 100,
    targetDistancePct: (Math.abs(target - entryPrice) / entryPrice) * 100,
  };
}

function buildReasons(direction, factors, regimeInfo) {
  if (direction === 'NO_TRADE') return [`regime ${regimeInfo.regime}: ${regimeInfo.reason}`];
  const ranked = [...factors]
    .filter((f) => f.name !== 'uncertainty' && Math.abs(f.contribution) > 0.005)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 4);
  return [
    `${direction} — regime ${regimeInfo.regime} (${regimeInfo.reason})`,
    ...ranked.map((f) => `${f.name} ${f.value > 0 ? '+' : ''}${f.value.toFixed(3)} × ${f.weight} = ${f.contribution > 0 ? '+' : ''}${f.contribution.toFixed(3)} (${f.note})`),
  ];
}

/**
 * The mandatory "why not trading?" engine (§27).
 * A user must never have to guess why the system sat on its hands.
 */
function buildNoTradeReasons({ scores, unknowns, regimeInfo, minScore }) {
  const reasons = [];
  if (regimeInfo.regime === 'UNCERTAIN') reasons.push(`regime is UNCERTAIN (${regimeInfo.reason})`);
  if (regimeInfo.regime === 'HIGH_VOLATILITY') reasons.push(`volatility too high to size safely (${regimeInfo.reason})`);

  const best = Math.max(scores.long, scores.short);
  if (best < minScore) {
    reasons.push(
      `model score ${(best * 100).toFixed(0)}% below the ${Math.round(minScore * 100)}% confidence floor`,
    );
  }
  if (scores.noTrade >= best) {
    reasons.push(`uncertainty score ${(scores.noTrade * 100).toFixed(0)}% outweighs the directional score`);
  }
  if (Math.abs(scores.long - scores.short) < 0.1 && best >= minScore) {
    reasons.push('long and short evidence conflict — no clear edge');
  }
  reasons.push(...unknowns.map((u) => `data quality: ${u}`));
  return reasons.length ? reasons : ['no setup met every gate'];
}

function noTrade(symbol, features, regimeInfo, factors, reason) {
  return {
    symbol,
    direction: 'NO_TRADE',
    scores: { long: 0, short: 0, noTrade: 1 },
    confidence: 1,
    regime: regimeInfo.regime,
    regimeReason: regimeInfo.reason,
    strategy: 'none',
    features,
    factors,
    geometry: null,
    entryPrice: null,
    reasons: [],
    noTradeReasons: [reason],
    invalidation: 'no position proposed',
    modelScoreNotProbability: true,
  };
}

function clamp(v, lo, hi) {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}
