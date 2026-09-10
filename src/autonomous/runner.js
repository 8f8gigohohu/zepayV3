import { EventEmitter } from 'node:events';
import { discoverUniverse } from '../scanner/scanner.js';

/**
 * Drives the autonomous pipeline on a timer.
 *
 * This class owns *scheduling* only. Every decision, every gate and every
 * execution still happens inside `AutonomousPipeline`, so running on a clock
 * adds no path that bypasses the risk engine, the kill switch or permissions.
 *
 * The universe is re-discovered periodically rather than cached forever: ZebPay
 * can list or delist symbols, and a stale universe means silently trading
 * something that no longer exists. A discovery failure keeps the previous
 * universe and records the error instead of clearing it — losing the list would
 * stop trading for a transient network blip, while trading a delisted symbol
 * fails at the exchange anyway.
 *
 * Events:
 *   'cycle'   — `{ ranked, acted, cycle, durationMs, symbols }`
 *   'error'   — recoverable failure (discovery, cycle); the loop keeps running
 *   'universe'— refreshed symbol list
 */
export class AutonomousRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./pipeline.js').AutonomousPipeline} opts.pipeline
   * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} [opts.client]
   *        Needed only for automatic universe discovery. Omit it and pass
   *        `symbols` to scan a fixed list.
   * @param {string[]} [opts.symbols]  explicit universe; skips discovery
   * @param {number} [opts.pollMs]     milliseconds between cycles (default 60s)
   * @param {object} [opts.universeFilter]
   * @param {number} [opts.rediscoverEvery]  rediscover after this many cycles
   * @param {boolean} [opts.autostart]
   */
  constructor(opts = {}) {
    super();
    const {
      pipeline,
      client = null,
      symbols = null,
      pollMs = 60_000,
      universeFilter = {},
      rediscoverEvery = 30,
      autostart = false,
    } = opts;

    for (const key of ['pipeline']) {
      if (!opts[key]) throw new Error(`AutonomousRunner requires '${key}'`);
    }
    if (!client && !symbols?.length) {
      throw new Error("AutonomousRunner needs either 'client' (to discover symbols) or 'symbols'");
    }

    this.pipeline = pipeline;
    this.client = client;
    this.pollMs = pollMs;
    this.universeFilter = universeFilter;
    this.rediscoverEvery = rediscoverEvery;

    /** @type {string[]} */
    this.symbols = (symbols ?? []).slice();
    this.explicit = Boolean(symbols?.length);

    this.running = false;
    this.busy = false;
    this.cycles = 0;
    this.errors = 0;
    this.lastCycleAt = null;
    this.lastDurationMs = null;
    this.lastUniverseAt = null;
    this.universeError = null;
    this.lastResult = null;

    this.#timer = null;

    // A discovery or cycle failure is an expected operational condition, not a
    // programmer error. Node rethrows an 'error' event with no listener, which
    // would turn one bad upstream request into a crash for any caller that only
    // wants the scan results. Default to a no-op; observers add their own.
    this.on('error', () => {});

    if (autostart) this.start();
  }

  #timer;

  start() {
    if (this.running) return this;
    this.running = true;
    this.#timer = setInterval(() => {
      // A slow cycle must never overlap the next one.
      if (!this.busy) this.cycle().catch(() => {});
    }, this.pollMs);
    this.#timer.unref?.();
    // Kick off immediately rather than waiting a full interval.
    this.cycle().catch(() => {});
    return this;
  }

  stop() {
    this.running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    return this;
  }

  /**
   * Refresh the symbol universe. Never throws.
   * @returns {Promise<string[]>}
   */
  async refreshUniverse() {
    if (this.explicit) return this.symbols;
    try {
      const universe = await discoverUniverse({ client: this.client, filter: this.universeFilter });
      this.symbols = universe.map((u) => u.symbol);
      this.lastUniverseAt = Date.now();
      this.universeError = null;
      this.emit('universe', this.symbols);
    } catch (err) {
      // Keep the last good list; report the failure so the UI can show it.
      this.errors += 1;
      this.universeError = err.message;
      this.emit('error', err);
    }
    return this.symbols;
  }

  /**
   * Run exactly one scan-and-evaluate pass. Never throws: a failure is counted,
   * emitted and returned as an error state, because a crash here would kill the
   * whole loop over one bad request.
   */
  async cycle() {
    if (this.busy) return this.lastResult;
    this.busy = true;
    const started = Date.now();

    try {
      if (this.cycles % this.rediscoverEvery === 0) await this.refreshUniverse();
      if (this.symbols.length === 0) {
        const err = new Error(
          this.universeError
            ? `no symbols to scan (universe discovery failed: ${this.universeError})`
            : 'no symbols to scan',
        );
        this.errors += 1;
        this.emit('error', err);
        return (this.lastResult = {
          ok: false, error: err.message, ranked: [], acted: null,
          cycle: this.cycles, durationMs: Date.now() - started, symbols: 0,
        });
      }

      const { ranked, acted } = await this.pipeline.runCycle(this.symbols);
      this.cycles += 1;
      this.lastCycleAt = Date.now();
      this.lastDurationMs = Date.now() - started;
      this.lastResult = {
        ok: true,
        error: null,
        ranked,
        acted,
        cycle: this.cycles,
        durationMs: this.lastDurationMs,
        symbols: this.symbols.length,
        at: this.lastCycleAt,
      };
      this.emit('cycle', this.lastResult);
      return this.lastResult;
    } catch (err) {
      this.errors += 1;
      this.emit('error', err);
      return (this.lastResult = {
        ok: false, error: err.message, ranked: [], acted: null,
        cycle: this.cycles, durationMs: Date.now() - started, symbols: this.symbols.length,
      });
    } finally {
      this.busy = false;
    }
  }

  status() {
    return {
      running: this.running,
      busy: this.busy,
      cycles: this.cycles,
      errors: this.errors,
      pollMs: this.pollMs,
      symbols: this.symbols.length,
      symbolList: this.symbols.slice(0, 100),
      lastCycleAt: this.lastCycleAt,
      lastDurationMs: this.lastDurationMs,
      lastUniverseAt: this.lastUniverseAt,
      universeError: this.universeError,
      pipeline: this.pipeline.status(),
    };
  }
}
