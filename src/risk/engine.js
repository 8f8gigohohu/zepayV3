/**
 * Risk Engine — the FINAL AUTHORITY.
 *
 * Architecture (§66 of the spec, enforced here):
 *
 *   DATA → AI → STRATEGY → SIMULATION → COST ENGINE → **RISK ENGINE**
 *        → PERMISSION ENGINE → EXECUTION → AUDIT
 *
 * The AI produces a *proposal*. This module can reject it, and nothing in the
 * AI layer can override that. Every rejection carries a machine-readable code
 * and a human reason, because "why didn't it trade?" must always be answerable.
 */

/** Default limits. Every one is overridable from config; none is a guess at
 *  what is "safe" — they are deliberately conservative starting points. */
export const DEFAULT_RISK_LIMITS = {
  maxPositionNotional: 100_000,
  maxLeverage: 10,
  // Exposure is measured as notional / equity. On isolated-margin futures a
  // position's notional routinely approaches or exceeds equity — a 1% risk
  // budget with a ~1% stop implies roughly 100% notional at 1x. These defaults
  // are therefore set relative to that reality, not to a spot-trading intuition
  // where "exposure" means the fraction of cash deployed.
  maxAccountExposurePct: 200,  // total open notional as % of equity
  maxPairExposurePct: 100,     // single-symbol notional as % of equity
  maxDailyLossPct: 3,
  maxWeeklyLossPct: 6,
  maxDrawdownPct: 15,
  maxConsecutiveLosses: 3,
  maxOpenPositions: 3,
  maxCorrelatedPositions: 2,
  minLiquidityNotional: 250_000,
  maxSpreadBps: 25,
  maxSlippageBps: 15,
  minNetEdgePct: 0.05,         // net edge after ALL costs, on notional
  minRiskReward: 1.2,
  minModelConfidence: 0.55,
  minLiquidationDistancePct: 8,
  maxDataAgeMs: 15_000,
  requireHealthyApi: true,
};

export class RiskEngine {
  /**
   * @param {object} [limits] merged over DEFAULT_RISK_LIMITS
   */
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_RISK_LIMITS, ...limits };
    /** @type {Array} rejection history, newest last */
    this.decisions = [];
    this.halted = false;
    this.haltReason = null;
  }

  /** Hard stop. Nothing passes an evaluate() while halted. */
  halt(reason) {
    this.halted = true;
    this.haltReason = reason;
  }

  resume() {
    this.halted = false;
    this.haltReason = null;
  }

  /**
   * Evaluate one proposed trade. Returns a verdict; never throws.
   *
   * @param {object} args
   * @param {object} args.proposal   output of the cost engine (`projectTrade`)
   * @param {object} args.context    account + market state, see below
   * @returns {{approved:boolean, code:string, reason:string, checks:Array}}
   */
  evaluate({ proposal, context = {} }) {
    const checks = [];
    const add = (code, ok, reason) => checks.push({ code, ok, reason });

    // 0. Kill switch outranks everything, including a valid-looking trade.
    if (this.halted) {
      return this.#verdict(false, 'HALTED', `trading halted: ${this.haltReason}`, checks);
    }

    const L = this.limits;
    const {
      equity = 0,
      openPositions = [],
      dailyPnlPct = 0,
      weeklyPnlPct = 0,
      drawdownPct = 0,
      consecutiveLosses = 0,
      dataAgeMs = null,
      apiHealthy = true,
      correlationGroup = null,
    } = context;

    // ── Data integrity gates first. A decision on stale data is worse than no
    //    decision, so these run before any profitability reasoning.
    add('DATA_FRESH', dataAgeMs === null || dataAgeMs <= L.maxDataAgeMs,
      dataAgeMs === null ? 'no data timestamp supplied' : `data age ${dataAgeMs}ms (limit ${L.maxDataAgeMs}ms)`);

    add('API_HEALTH', !L.requireHealthyApi || apiHealthy === true,
      apiHealthy ? 'api healthy' : 'api unhealthy');

    if (equity <= 0) {
      add('EQUITY', false, 'no equity available');
      return this.#verdict(false, 'EQUITY', 'cannot size a position without equity', checks);
    }
    add('EQUITY', true, `equity ${equity}`);

    // ── Account-level drawdown / loss limits
    add('DAILY_LOSS', dailyPnlPct > -L.maxDailyLossPct,
      `daily ${dailyPnlPct.toFixed(2)}% (limit -${L.maxDailyLossPct}%)`);
    add('WEEKLY_LOSS', weeklyPnlPct > -L.maxWeeklyLossPct,
      `weekly ${weeklyPnlPct.toFixed(2)}% (limit -${L.maxWeeklyLossPct}%)`);
    add('DRAWDOWN', drawdownPct < L.maxDrawdownPct,
      `drawdown ${drawdownPct.toFixed(2)}% (limit ${L.maxDrawdownPct}%)`);
    add('CONSECUTIVE_LOSSES', consecutiveLosses < L.maxConsecutiveLosses,
      `${consecutiveLosses} consecutive losses (limit ${L.maxConsecutiveLosses})`);

    // ── Position sizing limits
    add('POSITION_SIZE', proposal.notional <= L.maxPositionNotional,
      `notional ${Math.round(proposal.notional)} (limit ${L.maxPositionNotional})`);
    add('LEVERAGE', proposal.leverage <= L.maxLeverage,
      `${proposal.leverage}x (limit ${L.maxLeverage}x)`);

    const pairExposurePct = (proposal.notional / equity) * 100;
    add('PAIR_EXPOSURE', pairExposurePct <= L.maxPairExposurePct,
      `${pairExposurePct.toFixed(1)}% of equity (limit ${L.maxPairExposurePct}%)`);

    const openNotional = openPositions.reduce((a, p) => a + (p.notional ?? 0), 0);
    const totalExposurePct = ((openNotional + proposal.notional) / equity) * 100;
    add('ACCOUNT_EXPOSURE', totalExposurePct <= L.maxAccountExposurePct,
      `${totalExposurePct.toFixed(1)}% of equity (limit ${L.maxAccountExposurePct}%)`);

    // ── Open position count, and correlated concentration
    add('OPEN_POSITIONS', openPositions.length < L.maxOpenPositions,
      `${openPositions.length} open (limit ${L.maxOpenPositions})`);

    if (correlationGroup) {
      const same = openPositions.filter((p) => p.correlationGroup === correlationGroup).length;
      add('CORRELATION', same < L.maxCorrelatedPositions,
        `${same} correlated open (limit ${L.maxCorrelatedPositions})`);
    }

    // ── Market quality
    const spreadBps = proposal.execution?.spreadBps ?? null;
    if (spreadBps !== null) {
      add('SPREAD', spreadBps <= L.maxSpreadBps,
        `${spreadBps.toFixed(1)}bps (limit ${L.maxSpreadBps}bps)`);
    }
    const slippageBps = proposal.notional > 0
      ? (proposal.costs.slippage / proposal.notional) * 10_000
      : 0;
    add('SLIPPAGE', slippageBps <= L.maxSlippageBps,
      `${slippageBps.toFixed(1)}bps (limit ${L.maxSlippageBps}bps)`);

    // ── The trade must actually clear its costs by a margin
    add('NET_EDGE', proposal.netEdgePct >= L.minNetEdgePct,
      `net edge ${proposal.netEdgePct.toFixed(3)}% (min ${L.minNetEdgePct}%)`);

    add('RISK_REWARD', proposal.riskReward >= L.minRiskReward,
      `R:R ${proposal.riskReward.toFixed(2)} (min ${L.minRiskReward})`);

    // An infinite distance means the position is over-collateralised and cannot
    // be liquidated at any price; say so instead of printing "Infinity%".
    add('LIQUIDATION_DISTANCE', proposal.distanceToLiquidationPct >= L.minLiquidationDistancePct,
      Number.isFinite(proposal.distanceToLiquidationPct)
        ? `${proposal.distanceToLiquidationPct.toFixed(1)}% (min ${L.minLiquidationDistancePct}%)`
        : `no reachable liquidation price (min ${L.minLiquidationDistancePct}%)`);

    const failed = checks.filter((c) => !c.ok);
    if (failed.length === 0) {
      return this.#verdict(true, 'APPROVED', 'all risk checks passed', checks);
    }
    // Report the *most binding* failure first so the UI can explain the trade.
    return this.#verdict(false, failed[0].code, failed.map((f) => f.reason).join('; '), checks);
  }

  #verdict(approved, code, reason, checks) {
    const verdict = { approved, code, reason, checks, at: Date.now() };
    this.decisions.push(verdict);
    if (this.decisions.length > 500) this.decisions.shift();
    return verdict;
  }

  /** Summary for the dashboard. */
  status() {
    const recent = this.decisions.slice(-50);
    return {
      halted: this.halted,
      haltReason: this.haltReason,
      limits: this.limits,
      evaluated: this.decisions.length,
      approved: recent.filter((d) => d.approved).length,
      rejected: recent.filter((d) => !d.approved).length,
      lastCode: this.decisions.at(-1)?.code ?? null,
      lastReason: this.decisions.at(-1)?.reason ?? null,
    };
  }
}
