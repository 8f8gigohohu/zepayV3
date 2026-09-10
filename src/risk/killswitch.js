import { EventEmitter } from 'node:events';

/**
 * Kill switch and circuit breaker.
 *
 * Two distinct things, deliberately separated:
 *
 *   - **Kill switch**: a human decision. Latched — it stays on until someone
 *     explicitly resumes. Nothing auto-clears it.
 *   - **Circuit breaker**: automatic. Trips on measurable failure conditions
 *     (stale data, API failure, anomalous price, repeated order failures) and
 *     also latches, because a system that silently recovers from a fault hides
 *     the fault.
 *
 * Both funnel into a single `blocked` flag the execution layer consults.
 */
export class KillSwitch extends EventEmitter {
  constructor() {
    super();
    this.manual = false;
    this.manualReason = null;
    this.breaker = false;
    this.breakerReasons = [];
    /** @type {Array} trip history */
    this.events = [];
    this.on('error', () => {});
  }

  /** True when trading must not proceed. */
  get blocked() {
    return this.manual || this.breaker;
  }

  get reason() {
    if (this.manual) return `kill switch: ${this.manualReason}`;
    if (this.breaker) return `circuit breaker: ${this.breakerReasons.join(', ')}`;
    return null;
  }

  /**
   * Engage the manual kill switch. Idempotent.
   * @param {string} reason required — an unexplained halt is unauditable
   */
  engage(reason) {
    if (!reason) throw new TypeError('a reason is required to engage the kill switch');
    if (this.manual) return false;
    this.manual = true;
    this.manualReason = reason;
    this.#record('KILL_SWITCH_ENGAGED', reason);
    this.emit('engage', { reason });
    return true;
  }

  /**
   * Resume after a manual halt. Requires an explicit reason for the audit trail.
   */
  resume(reason) {
    if (!reason) throw new TypeError('a reason is required to resume');
    if (!this.manual) return false;
    this.manual = false;
    this.manualReason = null;
    this.#record('KILL_SWITCH_RESUMED', reason);
    this.emit('resume', { reason });
    return true;
  }

  /**
   * Trip the circuit breaker for a measured condition.
   * @param {string} code   e.g. `STALE_DATA`, `API_FAILURE`, `PRICE_ANOMALY`
   * @param {string} detail
   */
  trip(code, detail = '') {
    if (!code) throw new TypeError('a code is required to trip the circuit breaker');
    if (this.breakerReasons.includes(code)) return false;
    this.breaker = true;
    this.breakerReasons.push(code);
    this.#record('BREAKER_TRIPPED', `${code}${detail ? `: ${detail}` : ''}`);
    this.emit('trip', { code, detail });
    return true;
  }

  /** Clear the breaker. Manual kill switch state is left untouched. */
  resetBreaker() {
    if (!this.breaker) return false;
    const cleared = [...this.breakerReasons];
    this.breaker = false;
    this.breakerReasons = [];
    this.#record('BREAKER_RESET', cleared.join(', '));
    this.emit('reset', { cleared });
    return true;
  }

  /**
   * Run the automatic health checks that can trip the breaker.
   *
   * Called on every engine cycle. Cheap and side-effecting by design: the
   * system must notice its own faults without a human watching.
   *
   * @param {object} args
   * @param {number} [args.dataAgeMs]
   * @param {number} [args.maxDataAgeMs]
   * @param {boolean} [args.apiHealthy]
   * @param {number} [args.priceMovePct]   move since the last check
   * @param {number} [args.maxPriceMovePct]
   * @param {number} [args.consecutiveOrderFailures]
   * @param {number} [args.maxConsecutiveOrderFailures]
   */
  checkHealth({
    dataAgeMs = 0,
    maxDataAgeMs = 30_000,
    apiHealthy = true,
    priceMovePct = 0,
    maxPriceMovePct = 15,
    consecutiveOrderFailures = 0,
    maxConsecutiveOrderFailures = 3,
  }) {
    if (!apiHealthy) this.trip('API_FAILURE', 'api reported unhealthy');
    if (dataAgeMs > maxDataAgeMs) this.trip('STALE_DATA', `data age ${dataAgeMs}ms > ${maxDataAgeMs}ms`);
    if (Math.abs(priceMovePct) > maxPriceMovePct) {
      this.trip('PRICE_ANOMALY', `move ${priceMovePct.toFixed(2)}% > ${maxPriceMovePct}%`);
    }
    if (consecutiveOrderFailures >= maxConsecutiveOrderFailures) {
      this.trip('ORDER_FAILURES', `${consecutiveOrderFailures} consecutive failures`);
    }
    return this.blocked;
  }

  #record(type, detail) {
    this.events.push({ type, detail, at: Date.now() });
    if (this.events.length > 500) this.events.shift();
  }

  status() {
    return {
      blocked: this.blocked,
      manual: this.manual,
      manualReason: this.manualReason,
      breaker: this.breaker,
      breakerReasons: [...this.breakerReasons],
      reason: this.reason,
      recentEvents: this.events.slice(-20),
    };
  }
}
