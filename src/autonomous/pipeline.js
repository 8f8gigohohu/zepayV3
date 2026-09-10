import { projectTrade, sizeByRisk } from '../costs/engine.js';
import { LiveTradingBlockedError } from '../core/errors.js';

/**
 * Autonomous decision pipeline (§65).
 *
 * The exact gate sequence, in order, with no shortcuts:
 *
 *   market data → validation → features → regime → AI decision → strategy
 *   → geometry → position sizing → cost projection → risk engine
 *   → permission engine → execution → audit
 *
 * Two invariants hold throughout:
 *
 *   - **The AI cannot reach execution.** It returns a proposal object; only
 *     this pipeline can call the order gateway, and only after Risk and
 *     Permission both approve.
 *   - **NO_TRADE is a first-class result**, fully reasoned. Roughly all the
 *     time in a quiet market, that is the correct answer.
 */
export class AutonomousPipeline {
  /**
   * @param {object} deps
   * @param {import('../ai/engine.js').ReturnType} deps.ai        decision engine
   * @param {import('../risk/engine.js').RiskEngine} deps.risk
   * @param {import('../permissions/engine.js').PermissionEngine} deps.permissions
   * @param {import('../risk/killswitch.js').KillSwitch} deps.killSwitch
   * @param {import('../strategy/OrderGateway.js').OrderGateway} deps.gateway
   * @param {import('../audit/log.js').AuditLog} deps.audit
   * @param {(symbol:string)=>Promise<{candles:Array, book:object|null, dataAgeMs:number|null}>} deps.fetchSymbol
   * @param {() => Promise<{equity:number, openPositions:Array, dailyPnlPct:number, weeklyPnlPct:number, drawdownPct:number, consecutiveLosses:number, apiHealthy:boolean}>} deps.fetchAccount
   * @param {object} [deps.costConfig]
   * @param {number} [deps.riskPerTradePct]
   * @param {number} [deps.minLiquidityScore]
   */
  constructor(deps) {
    for (const k of ['ai', 'risk', 'permissions', 'killSwitch', 'gateway', 'audit', 'fetchSymbol', 'fetchAccount']) {
      if (!deps[k]) throw new TypeError(`AutonomousPipeline requires "${k}"`);
    }
    Object.assign(this, deps);
    this.costConfig = deps.costConfig ?? {};
    this.riskPerTradePct = deps.riskPerTradePct ?? 1;
    this.minLiquidityScore = deps.minLiquidityScore ?? 0;
    this.cycles = 0;
    this.executions = 0;
    this.noTrades = 0;
  }

  /**
   * Evaluate one symbol end-to-end WITHOUT executing. This is the simulation
   * path the UI shows before any order is sent.
   *
   * @param {string} symbol
   * @returns {Promise<object>} full trace
   */
  async evaluate(symbol) {
    const trace = {
      symbol,
      stage: 'start',
      at: Date.now(),
      decision: null,
      sizing: null,
      projection: null,
      riskVerdict: null,
      permission: null,
      action: 'NO_TRADE',
      reasons: [],
    };

    // ── 1. Kill switch outranks everything, before any work is done.
    if (this.killSwitch.blocked) {
      trace.stage = 'kill_switch';
      trace.reasons.push(this.killSwitch.reason);
      return trace;
    }

    // ── 2. Market data + validation
    let data;
    try {
      data = await this.fetchSymbol(symbol);
    } catch (err) {
      trace.stage = 'data';
      trace.reasons.push(`market data unavailable: ${err.message}`);
      return trace;
    }
    const { candles = [], book = null, dataAgeMs = null } = data ?? {};
    if (!candles.length) {
      trace.stage = 'data';
      trace.reasons.push('no candles returned');
      return trace;
    }

    // ── 3-6. Features, regime, AI decision
    const decision = this.ai.decide({ symbol, candles, book, minLiquidityScore: this.minLiquidityScore });
    trace.decision = decision;
    trace.stage = 'ai';

    if (decision.direction === 'NO_TRADE') {
      trace.reasons.push(...decision.noTradeReasons);
      this.audit.record('AI_NO_TRADE', { symbol, reasons: decision.noTradeReasons, scores: decision.scores, regime: decision.regime });
      return trace;
    }

    // ── 7-9. Geometry + sizing
    const account = await this.fetchAccount();
    const geo = decision.geometry;
    if (!geo) {
      trace.stage = 'geometry';
      trace.reasons.push('no trade geometry could be derived (missing ATR or price)');
      return trace;
    }

    const sizing = sizeByRisk({
      equity: account.equity,
      entryPrice: geo.entryPrice,
      stopLossPrice: geo.stopLoss,
      riskPerTradePct: this.riskPerTradePct,
      maxLeverage: this.permissions.can('allowHighLeverage') ? geo.maxLeverage : Math.min(geo.maxLeverage, 5),
      // Size inside the risk engine's limits up front, so a proposal is not
      // built only to be rejected for being too large.
      maxNotional: Math.min(
        this.risk.limits.maxPositionNotional,
        (account.equity * this.risk.limits.maxPairExposurePct) / 100,
      ),
    });
    trace.sizing = sizing;
    trace.stage = 'sizing';

    if (sizing.quantity <= 0) {
      trace.reasons.push(`position size is zero (capped by ${sizing.cappedBy})`);
      return trace;
    }

    // ── 10-12. Cost projection — the honest net number
    const projection = projectTrade({
      direction: decision.direction,
      entryPrice: geo.entryPrice,
      quantity: sizing.quantity,
      leverage: sizing.leverage,
      exitPrice: geo.target,
      stopLossPrice: geo.stopLoss,
      book,
      config: this.costConfig,
    });
    trace.projection = projection;
    trace.stage = 'cost';

    // Surface the measured spread to the risk engine.
    projection.execution.spreadBps = decision.features.spreadBps ?? null;

    // ── 13. Risk Engine — FINAL AUTHORITY
    const riskVerdict = this.risk.evaluate({
      proposal: projection,
      context: {
        ...account,
        dataAgeMs,
        correlationGroup: correlationGroupOf(symbol),
      },
    });
    trace.riskVerdict = riskVerdict;
    trace.stage = 'risk';
    this.audit.record('RISK_VERDICT', { symbol, approved: riskVerdict.approved, code: riskVerdict.code, reason: riskVerdict.reason });

    if (!riskVerdict.approved) {
      trace.reasons.push(`risk engine: ${riskVerdict.code} — ${riskVerdict.reason}`);
      return trace;
    }

    // ── 14. Permission Engine
    const needs = decision.direction === 'NO_TRADE' ? null : 'autonomousEntries';
    const allowed = this.permissions.can(needs);
    trace.permission = { required: needs, allowed };
    trace.stage = 'permission';
    if (!allowed) {
      trace.reasons.push(`permission denied: ${needs} is disabled`);
      return trace;
    }

    trace.action = decision.direction;
    trace.stage = 'approved';
    return trace;
  }

  /**
   * Evaluate one symbol and, if every gate passes, execute.
   *
   * Execution still passes through the OrderGateway, which applies its own
   * independent live-trading gate. Approval here does NOT mean a real order is
   * sent — in dry-run the gateway simulates the fill.
   *
   * @param {string} symbol
   * @returns {Promise<{trace:object, execution:object|null}>}
   */
  async runSymbol(symbol) {
    const trace = await this.evaluate(symbol);

    if (trace.action === 'NO_TRADE') {
      this.noTrades += 1;
      this.audit.record('NO_TRADE', { symbol, stage: trace.stage, reasons: trace.reasons });
      return { trace, execution: null };
    }

    this.audit.record('AI_DECISION', {
      symbol,
      direction: trace.decision.direction,
      scores: trace.decision.scores,
      regime: trace.decision.regime,
      strategy: trace.decision.strategy,
      netPnl: trace.projection.netPnl,
      netEdgePct: trace.projection.netEdgePct,
      riskReward: trace.projection.riskReward,
    });

    let execution = null;
    try {
      execution = await this.gateway.placeOrder({
        symbol,
        side: trace.decision.direction === 'LONG' ? 'BUY' : 'SELL',
        type: 'MARKET',
        amount: trace.sizing.quantity,
      });
      this.executions += 1;
      this.audit.record('ORDER_SENT', {
        symbol,
        mode: execution.mode,
        side: execution.request?.side,
        amount: execution.request?.amount,
        price: execution.price ?? null,
        clientOrderId: execution.clientOrderId ?? null,
      });
    } catch (err) {
      // A blocked live send is a policy outcome, not a fault — record it as such.
      const type = err instanceof LiveTradingBlockedError ? 'LIVE_BLOCKED' : 'ORDER_ERROR';
      this.audit.record(type, { symbol, message: err.message });
      trace.reasons.push(`${type.toLowerCase()}: ${err.message}`);
    }

    return { trace, execution };
  }

  /**
   * Scan every candidate symbol, rank by opportunity, and act on the best one
   * that clears all gates. Never opens more than one position per cycle.
   *
   * @param {string[]} symbols
   * @returns {Promise<{ranked:Array, acted:object|null}>}
   */
  async runCycle(symbols) {
    this.cycles += 1;
    const ranked = [];

    for (const symbol of symbols) {
      try {
        const trace = await this.evaluate(symbol);
        ranked.push(summarise(trace));
      } catch (err) {
        ranked.push({ symbol, action: 'NO_TRADE', score: 0, reason: `evaluation failed: ${err.message}` });
      }
    }

    ranked.sort((a, b) => b.score - a.score);
    this.audit.record('SCAN_CYCLE', {
      cycle: this.cycles,
      symbols: symbols.length,
      top: ranked.slice(0, 5),
    });

    const best = ranked.find((r) => r.action !== 'NO_TRADE');
    if (!best) return { ranked, acted: null };

    const { trace, execution } = await this.runSymbol(best.symbol);
    return { ranked, acted: { trace, execution } };
  }

  status() {
    return {
      cycles: this.cycles,
      executions: this.executions,
      noTrades: this.noTrades,
      risk: this.risk.status(),
      killSwitch: this.killSwitch.status(),
      permissions: this.permissions.snapshot(),
    };
  }
}

/** Reduce a trace to a ranking row. */
/**
 * Round for the summary payload, preserving "no value".
 *
 * `liquidationPrice` is legitimately `null` when a position is
 * over-collateralised and cannot be liquidated, so calling `.toFixed()` on it
 * directly throws. Reporting `null` keeps that fact visible instead of
 * inventing a price.
 */
function round(value, dp) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(dp)) : null;
}

function summarise(trace) {
  const d = trace.decision;
  if (!d || trace.action === 'NO_TRADE') {
    return {
      symbol: trace.symbol,
      action: 'NO_TRADE',
      score: 0,
      reason: trace.reasons[0] ?? 'no setup',
      regime: d?.regime ?? null,
    };
  }
  return {
    symbol: trace.symbol,
    action: d.direction,
    score: round(d.confidence * 100, 1),
    regime: d.regime,
    strategy: d.strategy,
    entry: trace.projection.entryPrice,
    stop: trace.decision.geometry?.stopLoss ?? null,
    target: trace.decision.geometry?.target ?? null,
    netPnl: round(trace.projection.netPnl, 2),
    netEdgePct: round(trace.projection.netEdgePct, 4),
    riskReward: round(trace.projection.riskReward, 2),
    liquidation: round(trace.projection.liquidationPrice, 0),
    costs: round(trace.projection.costs.total, 2),
    why: d.reasons[0],
  };
}

/**
 * Crude correlation grouping so the risk engine can cap concentrated exposure.
 *
 * Without a covariance estimate this is deliberately blunt: quote asset and
 * major-vs-alt. It prevents the obvious failure (five BTC-correlated longs
 * counted as five independent bets) without pretending to measure correlation.
 */
function correlationGroupOf(symbol) {
  const s = String(symbol).toUpperCase();
  const quote = s.endsWith('USDT') ? 'USDT' : s.endsWith('INR') ? 'INR' : 'OTHER';
  const base = s.replace(/(USDT|INR)$/, '');
  const major = ['BTC', 'ETH'].includes(base) ? 'major' : 'alt';
  return `${quote}:${major}`;
}
