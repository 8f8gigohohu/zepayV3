/**
 * Permission Engine.
 *
 * Sits between the Risk Engine and execution. The Risk Engine answers "is this
 * trade safe?"; this answers "is this user *allowed* to do it right now?".
 *
 * Every dangerous capability defaults to **NO** (§33, §58). Nothing here is
 * ever enabled implicitly, and enabling live trading additionally requires the
 * separate `ZEBPAY_ALLOW_LIVE` + `--live` gate in the order gateway — two
 * independent locks on the same door.
 */

export const DEFAULT_PERMISSIONS = {
  // Reads — safe, on by default.
  readMarketData: true,
  readBalance: true,
  readPositions: true,
  readOrders: true,
  readTradeHistory: true,

  // Simulation — safe, on by default.
  paperTrading: true,
  runBacktest: true,
  runSimulation: true,

  // Writes — all default OFF.
  liveTrading: false,
  autonomousEntries: false,
  autonomousExits: false,
  autonomousReentry: false,
  allowLeverageChanges: false,
  allowMarginChanges: false,
  allowPositionReduction: false,
  allowPositionClosing: false,
  allowMultiplePositions: false,
  allowHighLeverage: false,
  requireLiveConfirmation: true,

  // Never available. Not a toggle — there is no code path that grants it.
  withdrawal: false,
};

/** Capabilities that must never be grantable, regardless of config. */
const FORBIDDEN = ['withdrawal'];

export class PermissionEngine {
  /**
   * @param {object} [overrides] merged over DEFAULT_PERMISSIONS
   * @param {(change:object)=>void} [onChange] audit hook
   */
  constructor(overrides = {}, onChange) {
    this.onChange = onChange;
    this.permissions = { ...DEFAULT_PERMISSIONS };
    // Reject any attempt to grant a forbidden capability, even explicitly.
    for (const [k, v] of Object.entries(overrides)) {
      if (FORBIDDEN.includes(k)) continue;
      if (k in this.permissions) this.permissions[k] = Boolean(v);
    }
    for (const k of FORBIDDEN) this.permissions[k] = false;
  }

  /**
   * Grant or revoke a capability. Records the change for the audit trail.
   * @param {string} key
   * @param {boolean} value
   * @param {string} [actor]
   */
  set(key, value, actor = 'user') {
    if (FORBIDDEN.includes(key)) {
      throw new Error(`${key} is forbidden platform-wide and cannot be granted`);
    }
    if (!(key in this.permissions)) {
      throw new Error(`unknown permission: ${key}`);
    }
    const before = this.permissions[key];
    this.permissions[key] = Boolean(value);
    if (before !== this.permissions[key]) {
      this.onChange?.({ type: 'PERMISSION_CHANGED', key, from: before, to: this.permissions[key], actor, at: Date.now() });
    }
    return this.permissions[key];
  }

  /** @param {string} key @returns {boolean} */
  can(key) {
    if (FORBIDDEN.includes(key)) return false;
    return this.permissions[key] === true;
  }

  /**
   * Require a capability, or throw with an actionable message.
   * @param {string} key
   * @param {string} [action]
   */
  require(key, action = key) {
    if (!this.can(key)) {
      throw new Error(
        `permission denied: "${action}" requires ${key}, which is disabled. ` +
          'Enable it explicitly in Settings → Permissions.',
      );
    }
  }

  /** The YES/NO grid for the permissions UI (§2, §33). */
  describe() {
    return Object.entries(this.permissions).map(([key, enabled]) => ({
      key,
      enabled,
      forbidden: FORBIDDEN.includes(key),
      dangerous: DANGEROUS.has(key),
      label: LABELS[key] ?? key,
    }));
  }

  /** Effective live-trading gate: permission AND the environment kill switch. */
  liveTradingAllowed({ allowLiveEnv = false, liveFlag = false } = {}) {
    return this.can('liveTrading') && allowLiveEnv && liveFlag;
  }

  snapshot() {
    return { ...this.permissions };
  }
}

/** Capabilities the UI should flag in red before enabling. */
const DANGEROUS = new Set([
  'liveTrading', 'autonomousEntries', 'autonomousExits', 'autonomousReentry',
  'allowHighLeverage', 'allowLeverageChanges', 'allowMarginChanges',
]);

const LABELS = {
  readMarketData: 'Read market data',
  readBalance: 'Read balance',
  readPositions: 'Read positions',
  readOrders: 'Read orders',
  readTradeHistory: 'Read trade history',
  paperTrading: 'Enable paper trading',
  runBacktest: 'Run backtests',
  runSimulation: 'Run simulations',
  liveTrading: 'Enable LIVE trading (real money)',
  autonomousEntries: 'Allow autonomous entries',
  autonomousExits: 'Allow autonomous exits',
  autonomousReentry: 'Allow automatic re-entry',
  allowLeverageChanges: 'Allow leverage changes',
  allowMarginChanges: 'Allow margin changes',
  allowPositionReduction: 'Allow position reduction',
  allowPositionClosing: 'Allow position closing',
  allowMultiplePositions: 'Allow multiple simultaneous positions',
  allowHighLeverage: 'Allow high leverage',
  requireLiveConfirmation: 'Require confirmation before live entry',
  withdrawal: 'Withdrawals (forbidden platform-wide)',
};
