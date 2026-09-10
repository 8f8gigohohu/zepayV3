/**
 * Cost, tax and liquidation engine.
 *
 * The single place where a proposed trade becomes a number you can act on.
 * Nothing downstream may show gross profit as expected profit: every consumer
 * of a decision uses `netPnl` from here.
 *
 * ── TDS / TAX HONESTY ─────────────────────────────────────────────────────
 * Tax rules are **not** hard-coded. `tdsRatePct` defaults to **0** (disabled)
 * because the correct rate depends on the user's jurisdiction, residential
 * status, transaction type and thresholds, and because inventing a rate would
 * be worse than omitting it. Configure it explicitly in settings.
 *
 * Every figure this module returns that is tax-derived is labelled
 * `ESTIMATE` by the caller. This is not tax advice and does not replace a
 * qualified tax professional.
 */

/** Sensible defaults; all overridable per-call or from config. */
export const DEFAULT_COST_CONFIG = {
  /** Taker fee in percent, e.g. 0.1 for 0.1%. ZebPay BTCINR taker is 0.1%. */
  takerFeePct: 0.1,
  makerFeePct: 0.05,
  /**
   * TDS in percent. Default 0 = disabled. Set explicitly if it applies to you.
   * Never inferred, never guessed.
   */
  tdsRatePct: 0,
  /** Extra one-side slippage in basis points, on top of the half-spread. */
  slippageBps: 2,
  /** Funding / holding cost per hour, in percent of notional. 0 if unknown. */
  fundingRatePerHourPct: 0,
  /**
   * Maintenance margin rate in percent, used for liquidation distance.
   * The `maintMarginPercent` field returned by `/api/v1/market/markets` has an
   * ambiguous unit in the current documentation, so it is NOT read implicitly
   * — pass an explicit value you have verified. Conservative default 0.5%.
   */
  maintenanceMarginPct: 0.5,
  /** Reference notional used by the depth-based impact model. */
  impactReferenceNotional: 5_000_000,
};

/**
 * Full cost + risk projection for one proposed trade.
 *
 * @param {object} args
 * @param {'LONG'|'SHORT'} args.direction
 * @param {number} args.entryPrice
 * @param {number} args.quantity          base-asset size
 * @param {number} args.leverage
 * @param {number} [args.exitPrice]       target; when omitted, gross is 0
 * @param {number} [args.stopLossPrice]
 * @param {number} [args.expectedHoldHours]
 * @param {{bids:Array, asks:Array}} [args.book]
 * @param {object} [args.config]          merged over DEFAULT_COST_CONFIG
 * @returns {object} projection
 */
export function projectTrade({
  direction,
  entryPrice,
  quantity,
  leverage,
  exitPrice,
  stopLossPrice,
  expectedHoldHours = 0,
  book,
  config = {},
}) {
  const cfg = { ...DEFAULT_COST_CONFIG, ...config };
  const side = String(direction).toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') {
    throw new TypeError(`direction must be LONG or SHORT, received ${direction}`);
  }
  for (const [k, v] of [['entryPrice', entryPrice], ['quantity', quantity], ['leverage', leverage]]) {
    if (!(v > 0)) throw new TypeError(`${k} must be a positive number, received ${v}`);
  }

  const notional = entryPrice * quantity;
  const margin = notional / leverage;

  // ── Execution price actually expected, after crossing the spread and impact.
  const execution = modelExecution({ book, side, notional, cfg, entryPrice });

  // ── Costs. Fees are charged on notional at entry AND exit.
  const feeOneWay = notional * (cfg.takerFeePct / 100);
  const fees = feeOneWay * 2;
  const tds = notional * (cfg.tdsRatePct / 100);
  const slippage = execution.slippageCost;
  const spreadCost = execution.spreadCost;
  const funding = notional * (cfg.fundingRatePerHourPct / 100) * expectedHoldHours;
  const totalCosts = fees + tds + slippage + spreadCost + funding;

  // ── Gross P&L. Zero when no exit is supplied, so a projection without a
  //    target honestly shows cost drag rather than a fabricated profit.
  const signed = side === 'LONG' ? 1 : -1;
  const grossPnl = exitPrice ? (exitPrice - entryPrice) * quantity * signed : 0;
  const netPnl = grossPnl - totalCosts;

  // ── Break-even: the price move that exactly offsets total costs.
  const breakEvenMove = quantity > 0 ? totalCosts / quantity : 0;
  const breakEvenPrice = side === 'LONG' ? entryPrice + breakEvenMove : entryPrice - breakEvenMove;
  const breakEvenMovePct = entryPrice > 0 ? (breakEvenMove / entryPrice) * 100 : 0;

  // ── Liquidation. Isolated-margin perpetual approximation:
  //      LONG  liq = entry * (1 - 1/lev + mmr)
  //      SHORT liq = entry * (1 + 1/lev - mmr)
  // This is an *estimate*: real liquidation depends on mark price, funding
  // accrual and the exchange's exact maintenance-margin schedule.
  //
  // When leverage is low enough that the formula goes non-positive, the position
  // is over-collateralised and cannot be liquidated at any price. That is
  // reported as `null` with an infinite distance rather than clamped to a
  // misleading price of zero.
  const mmr = cfg.maintenanceMarginPct / 100;
  let liquidationPrice;
  if (side === 'LONG') {
    const factor = 1 - 1 / leverage + mmr;
    liquidationPrice = factor > 0 ? entryPrice * factor : null;
  } else {
    const factor = 1 + 1 / leverage - mmr;
    liquidationPrice = factor > 0 ? entryPrice * factor : null;
  }
  const distanceToLiquidationPct =
    liquidationPrice === null
      ? Infinity
      : entryPrice > 0
        ? (Math.abs(entryPrice - liquidationPrice) / entryPrice) * 100
        : 0;

  // ── Max loss: stop loss if set, otherwise liquidation (worst case). A
  //    position that cannot be liquidated is still capped by its margin.
  const stopLoss = stopLossPrice
    ? Math.max(0, (Math.abs(entryPrice - stopLossPrice) * quantity))
    : null;
  const liquidationLoss =
    liquidationPrice === null ? Infinity : Math.abs(entryPrice - liquidationPrice) * quantity;
  const maxLoss = stopLoss !== null ? Math.min(stopLoss, margin) : Math.min(liquidationLoss, margin);

  const reward = exitPrice ? Math.max(0, (Math.abs(exitPrice - entryPrice) * quantity) - totalCosts) : 0;
  const riskReward = maxLoss > 0 ? reward / maxLoss : 0;

  return {
    direction: side,
    entryPrice,
    quantity,
    leverage,
    notional,
    margin,
    exitPrice: exitPrice ?? null,

    grossPnl,
    costs: {
      fees,
      tds,
      slippage,
      spread: spreadCost,
      funding,
      total: totalCosts,
    },
    netPnl,
    netRoiPct: margin > 0 ? (netPnl / margin) * 100 : 0,
    netEdgePct: notional > 0 ? (netPnl / notional) * 100 : 0,

    breakEvenPrice,
    breakEvenMovePct,
    liquidationPrice,
    distanceToLiquidationPct,
    maxLoss,
    stopLossPrice: stopLossPrice ?? null,
    riskReward,

    execution,
    tdsIsEstimate: cfg.tdsRatePct > 0,
  };
}

/**
 * Model realistic execution: half-spread to cross, plus depth-based impact.
 *
 * A naive simulator fills at mid and overstates edge. This charges the
 * half-spread and adds impact that grows with order size relative to visible
 * depth, which is the dominant cost for larger futures orders.
 */
function modelExecution({ book, side, notional, cfg, entryPrice }) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const hasBook = bids.length > 0 && asks.length > 0;

  let spreadCost = 0;
  let slippageCost = 0;
  let expectedFillPrice = entryPrice;

  if (hasBook) {
    const bestBid = Number(bids[0][0]);
    const bestAsk = Number(asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    // Crossing the book means paying the half-spread immediately.
    spreadCost = Math.abs(mid - (side === 'LONG' ? bestAsk : bestBid)) * (notional / entryPrice);

    // Impact: walk the book and compute the VWAP of the levels actually needed.
    const levels = side === 'LONG' ? asks : bids;
    const remaining = notional / entryPrice;
    const vwap = walkBook(levels, remaining);
    if (vwap !== null) {
      expectedFillPrice = vwap;
      slippageCost = Math.abs(vwap - mid) * remaining;
    }
  }

  // Add the configured flat slippage on top, covering latency and adverse
  // selection that the static book cannot show.
  slippageCost += notional * (cfg.slippageBps / 10_000);

  return {
    spreadCost,
    slippageCost,
    expectedFillPrice,
    usedBook: hasBook,
  };
}

/** VWAP of walking `qty` through a price/quantity ladder. */
function walkBook(levels, qty) {
  let filled = 0;
  let cost = 0;
  for (const [p, q] of levels) {
    const price = Number(p);
    const size = Number(q);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, qty - filled);
    cost += take * price;
    filled += take;
    if (filled >= qty) break;
  }
  if (filled <= 0) return null;
  // Partial fill: the remainder would fill worse than anything visible, so the
  // returned VWAP is already optimistic. Callers treat thin books as a risk.
  return cost / filled;
}

/**
 * Position size from a fixed fractional risk budget.
 *
 * Sizes so that hitting the stop loses at most `riskPerTradePct` of equity —
 * never sizes to "use all available margin", which is how accounts blow up.
 *
 * @param {object} args
 * @param {number} args.equity
 * @param {number} args.entryPrice
 * @param {number} args.stopLossPrice
 * @param {number} [args.riskPerTradePct] default 1%
 * @param {number} [args.maxLeverage]     caps the leverage actually used
 * @param {number} [args.maxNotional]     hard cap on position notional; lets the
 *   caller size *within* the risk engine's exposure limits instead of proposing
 *   something that will simply be rejected downstream
 * @param {number} [args.minQuantity]     exchange minimum; result is 0 below it
 * @returns {{quantity:number, leverage:number, margin:number, riskAmount:number, cappedBy:string}}
 */
export function sizeByRisk({
  equity,
  entryPrice,
  stopLossPrice,
  riskPerTradePct = 1,
  maxLeverage = 10,
  maxNotional = Infinity,
  minQuantity = 0,
}) {
  if (!(equity > 0)) throw new TypeError('equity must be positive');
  if (!(entryPrice > 0)) throw new TypeError('entryPrice must be positive');

  const riskAmount = equity * (riskPerTradePct / 100);
  const perUnitRisk = Math.abs(entryPrice - (stopLossPrice ?? entryPrice));

  if (!(perUnitRisk > 0)) {
    // No stop means unbounded risk: refuse rather than invent a size.
    return { quantity: 0, leverage: 0, margin: 0, riskAmount, cappedBy: 'NO_STOP' };
  }

  let quantity = riskAmount / perUnitRisk;
  let cappedBy = 'RISK';

  // Leverage cap: margin required must not exceed equity / maxLeverage.
  const leverageCeiling = equity * maxLeverage;
  if (quantity * entryPrice > leverageCeiling) {
    quantity = leverageCeiling / entryPrice;
    cappedBy = 'LEVERAGE';
  }

  // Exposure cap from the risk engine, applied here so the proposal is already
  // inside the limits rather than being rejected after the fact.
  if (Number.isFinite(maxNotional) && quantity * entryPrice > maxNotional) {
    quantity = maxNotional / entryPrice;
    cappedBy = 'EXPOSURE';
  }

  if (quantity < minQuantity) {
    return { quantity: 0, leverage: 0, margin: 0, riskAmount, cappedBy: 'MIN_SIZE' };
  }

  const notional = quantity * entryPrice;
  const leverage = Math.min(maxLeverage, notional / equity);

  return {
    quantity,
    leverage,
    margin: notional / leverage,
    riskAmount,
    cappedBy,
  };
}
