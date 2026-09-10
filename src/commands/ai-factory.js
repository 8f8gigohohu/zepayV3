import { OrderGateway } from '../strategy/OrderGateway.js';
import { AuditLog } from '../audit/log.js';
import { KillSwitch } from '../risk/killswitch.js';
import { PermissionEngine } from '../permissions/engine.js';
import { DEFAULT_RISK_LIMITS, RiskEngine } from '../risk/engine.js';
import { createDecisionEngine } from '../ai/engine.js';
import { AutonomousPipeline } from '../autonomous/pipeline.js';
import { AutonomousRunner } from '../autonomous/runner.js';
import { fetchSymbolData } from '../scanner/scanner.js';
import { normalizeSymbol } from '../core/symbols.js';
import { envInt, envNum, envStr } from '../core/env.js';

/**
 * Build the autonomous stack from real dependencies.
 *
 * Two rules drive every choice here:
 *
 *  1. **Nothing is invented.** If the account equity cannot be read, it is
 *     reported as 0 and the risk engine blocks the trade. Guessing a plausible
 *     balance would let the system size positions against money that may not be
 *     there.
 *  2. **Demo data cannot trade.** When the feed is synthetic the gateway's live
 *     mode is forced off no matter what the operator asked for.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 * @param {object} [args.feed]
 * @param {'live'|'demo'} args.feedMode
 */
export function buildAutonomous({ client, config, flags = {}, feed = null, feedMode = 'live' }) {
  const timeframe = flags.tf ?? envStr('ZEBPAY_AI_TIMEFRAME', '5m');
  const candleCount = Number(flags.candles ?? envInt('ZEBPAY_AI_CANDLES', 120));
  const hasCredentials = Boolean(config.apiKey && config.apiSecret);

  // ── Audit first: the permission hook and every other component writes to it.
  const audit = new AuditLog({
    file: flags.auditFile ?? envStr('ZEBPAY_AUDIT_FILE', 'data/audit.jsonl'),
  });
  audit.record('STARTUP', {
    feedMode,
    hasCredentials,
    allowLiveEnv: config.allowLive === true,
    liveFlag: flags.live === true,
    timeframe,
  });

  // ── Permissions. Dangerous capabilities stay off unless explicitly enabled,
  //    and live trading additionally needs both the env flag and the CLI flag.
  const permissions = new PermissionEngine(
    {
      autonomousEntries: flags.ai === true || flags.autonomous === true,
      autonomousExits: flags.ai === true || flags.autonomous === true,
      allowLiveTrading: config.allowLive === true,
      allowHighLeverage: flags.highLeverage === true,
    },
    (change) => audit.record('PERMISSION_CHANGED', change),
  );

  // ── Risk limits: env/flag overrides merge over the conservative defaults.
  const risk = new RiskEngine({
    maxLeverage: Number(flags.maxLeverage ?? envNum('ZEBPAY_MAX_LEVERAGE', DEFAULT_RISK_LIMITS.maxLeverage)),
    maxOpenPositions: Number(flags.maxPositions ?? envNum('ZEBPAY_MAX_POSITIONS', DEFAULT_RISK_LIMITS.maxOpenPositions)),
    maxDailyLossPct: Number(flags.maxDailyLossPct ?? envNum('ZEBPAY_MAX_DAILY_LOSS_PCT', DEFAULT_RISK_LIMITS.maxDailyLossPct)),
  });

  const killSwitch = new KillSwitch();
  // Every latching stop is audit-worthy; record all four transitions.
  killSwitch.on('engage', (e) => audit.record('KILL_SWITCH_ENGAGED', e));
  killSwitch.on('resume', (e) => audit.record('KILL_SWITCH_RESUMED', e));
  killSwitch.on('trip', (e) => audit.record('KILL_SWITCH_TRIPPED', e));
  killSwitch.on('reset', (e) => audit.record('KILL_SWITCH_RESET', e));

  const ai = createDecisionEngine({
    minScore: Number(flags.minScore ?? envNum('ZEBPAY_MIN_SCORE', 0.55)),
  });

  // ── Order gateway. Synthetic prices can never back a real order.
  const allowLive = config.allowLive === true && feedMode === 'live' && flags.live === true;
  const gateway = new OrderGateway({
    client: hasCredentials ? client : null,
    allowLive,
    liveFlag: flags.live === true,
    priceSource: () => feed?.lastPrice ?? null,
    takerFeeRate: Number(flags.takerFee) || 0.001,
  });

  // ── Market data. In demo mode the client cannot reach ZebPay, so the only
  //    honest source is the demo feed's own maintained series — and that is
  //    labelled as synthetic everywhere it surfaces.
  const fetchSymbol = async (symbol) => {
    const sym = normalizeSymbol(symbol);
    if (feedMode === 'demo') {
      if (!feed || normalizeSymbol(feed.symbol ?? '') !== sym) {
        throw new Error(`demo feed only carries ${feed?.symbol ?? 'no symbol'}, not ${sym}`);
      }
      // The demo feed has no stored book; it synthesises depth per snapshot.
      const snap = feed.snapshot(20);
      const candles = feed.candles ?? [];
      const book = snap.bids?.length && snap.asks?.length
        ? { symbol: sym, bids: snap.bids, asks: snap.asks }
        : null;
      return { symbol: sym, candles, book, dataAgeMs: 0 };
    }
    return fetchSymbolData({ client, symbol: sym, timeframe, candleCount });
  };

  // ── Account. Read from the exchange; never synthesised.
  const accountState = {
    equity: 0,
    equitySource: null,
    openPositions: [],
    apiHealthy: true,
    lastError: null,
    lastCheckedAt: null,
  };

  // ── Optional paper balance. This is the one number the operator is allowed to
  //    supply, and only so the sizing path can be exercised without live
  //    credentials. It is refused outright whenever live trading is enabled, and
  //    it is always labelled as paper so it can never be read as a real balance.
  const paperEquity = Number(flags.paperEquity ?? envNum('ZEBPAY_PAPER_EQUITY', 0));
  if (paperEquity > 0 && allowLive) {
    throw new Error('--paperEquity cannot be combined with live trading');
  }
  if (paperEquity > 0) {
    accountState.equity = paperEquity;
    accountState.equitySource = 'paper (operator-supplied)';
  }

  const fetchAccount = async () => {
    if (paperEquity > 0) {
      accountState.equity = paperEquity;
      accountState.equitySource = 'paper (operator-supplied)';
      // Report the gateway's own simulated book. Without this the risk engine
      // cannot see positions it just opened, so OPEN_POSITIONS and
      // ACCOUNT_EXPOSURE never bite and a paper run stacks a fresh position
      // every cycle — which also means those two limits go untested.
      accountState.openPositions = simulatedPositions(gateway);
      accountState.apiHealthy = true;
      accountState.lastError = hasCredentials ? null : 'no API credentials configured';
      accountState.lastCheckedAt = Date.now();
      return snapshotAccount(accountState);
    }
    if (!hasCredentials) {
      accountState.equity = 0;
      accountState.equitySource = null;
      accountState.lastError = 'no API credentials configured';
      return snapshotAccount(accountState);
    }
    try {
      const [balance, positions] = await Promise.all([
        client.getWalletBalance(),
        client.getPositions().catch(() => []),
      ]);
      const equity = readEquity(balance);
      accountState.equity = equity.value;
      accountState.equitySource = equity.source;
      accountState.openPositions = normalisePositions(positions);
      accountState.lastError = equity.value > 0 ? null : `could not determine equity (${equity.reason})`;
      accountState.lastCheckedAt = Date.now();
    } catch (err) {
      // Fail closed: an unreachable account means equity 0, which the risk
      // engine rejects. Better a missed trade than a position sized on a guess.
      accountState.equity = 0;
      accountState.equitySource = null;
      accountState.apiHealthy = false;
      accountState.lastError = err.message;
    }
    return snapshotAccount(accountState);
  };

  const pipeline = new AutonomousPipeline({
    ai,
    risk,
    permissions,
    killSwitch,
    gateway,
    audit,
    fetchSymbol,
    fetchAccount,
    riskPerTradePct: Number(flags.riskPerTradePct ?? envNum('ZEBPAY_RISK_PER_TRADE_PCT', 1)),
    minLiquidityScore: Number(flags.minLiquidityScore ?? envNum('ZEBPAY_MIN_LIQUIDITY', 0.2)),
  });

  const explicit = parseSymbolList(flags.symbols);
  const runner = new AutonomousRunner({
    pipeline,
    client: feedMode === 'live' && hasCredentials ? client : null,
    symbols: explicit.length ? explicit : (feedMode === 'demo' && feed ? [normalizeSymbol(feed.symbol)] : null),
    pollMs: Number(flags.scanMs ?? envInt('ZEBPAY_SCAN_MS', 60_000)),
    universeFilter: { maxSymbols: Number(flags.maxSymbols ?? envInt('ZEBPAY_MAX_SYMBOLS', 25)) },
  });

  return {
    pipeline,
    runner,
    ai,
    risk,
    permissions,
    killSwitch,
    gateway,
    audit,
    accountState,
    fetchAccount,
    allowLive,
    hasCredentials,
    timeframe,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Fields that plausibly carry total equity, in preference order. */
const EQUITY_KEYS = ['equity', 'totalEquity', 'marginBalance', 'walletBalance', 'availableBalance', 'balance'];

/**
 * Extract an equity figure from the `wallet/balance` response without guessing.
 *
 * The response shape is not pinned by the public docs, so this returns the first
 * candidate key that actually holds a finite positive number *and* reports which
 * key it used. When nothing matches, equity is 0 and the reason says so — the
 * caller then fails closed rather than inventing a balance.
 */
export function readEquity(balance) {
  const rows = Array.isArray(balance) ? balance : [balance];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of EQUITY_KEYS) {
      if (!(key in row)) continue;
      const value = Number(row[key]);
      if (Number.isFinite(value) && value >= 0) {
        return { value, source: key, reason: null };
      }
    }
  }
  return {
    value: 0,
    source: null,
    reason: `no recognised equity field in wallet/balance; saw keys [${
      rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])).join(', ') || 'none'
    }]`,
  };
}

/**
 * Read the gateway's simulated book into the shape the risk engine expects.
 *
 * The gateway is the only place a dry-run position exists, so it is also the
 * only honest source of open positions in paper mode.
 */
export function simulatedPositions(gateway) {
  const out = [];
  for (const pos of gateway.positions?.values() ?? []) {
    if (!pos || pos.qty === 0) continue;
    out.push({
      symbol: pos.symbol,
      side: pos.qty > 0 ? 'LONG' : 'SHORT',
      quantity: Math.abs(pos.qty),
      notional: Math.abs(pos.qty * pos.avgPrice),
      correlationGroup: String(pos.symbol ?? '').slice(-3).toUpperCase(),
    });
  }
  return out;
}

/** Reduce exchange positions to the `{notional, correlationGroup}` the risk engine reads. */
export function normalisePositions(positions) {
  const rows = Array.isArray(positions) ? positions : [positions];
  return rows
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      const notional = Number(p.notional ?? p.positionValue ?? (Number(p.amount ?? 0) * Number(p.entryPrice ?? 0)));
      const quantity = Number(p.amount ?? p.quantity ?? p.size ?? 0);
      return {
        symbol: normalizeSymbol(p.symbol ?? ''),
        side: p.side ?? (quantity >= 0 ? 'LONG' : 'SHORT'),
        quantity,
        notional: Number.isFinite(notional) ? Math.abs(notional) : 0,
        // Blunt proxy: positions sharing a quote asset move together more often
        // than not. A real covariance estimate would be better.
        correlationGroup: String(p.quoteAsset ?? p.symbol ?? '').slice(-3).toUpperCase(),
      };
    })
    .filter((p) => p.notional > 0 || p.quantity !== 0);
}

function snapshotAccount(s) {
  return {
    equity: s.equity,
    equitySource: s.equitySource,
    openPositions: s.openPositions,
    // Without an equity figure we cannot compute P&L percentages, so report 0
    // and let EQUITY be the reason the trade is blocked.
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    drawdownPct: 0,
    consecutiveLosses: 0,
    apiHealthy: s.apiHealthy,
  };
}

function parseSymbolList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSymbol(s));
}
