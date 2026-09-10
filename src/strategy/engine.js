import { EventEmitter } from 'node:events';
import { ValidationError } from '../core/errors.js';
import { normalizeSymbol } from '../core/symbols.js';

/**
 * Strategy engine: a polling loop that feeds closed candles to a strategy and
 * routes any resulting signals through an {@link OrderGateway}.
 *
 * Design notes:
 *
 * - **Only closed candles drive decisions.** The newest row from the klines
 *   endpoint is still forming, so acting on it would repaint: a signal computed
 *   mid-candle can vanish by candle close. `tick()` drops it and records where it
 *   stopped so the same candle is never acted on twice.
 * - **Polling rather than WebSocket** keeps the engine dependency-free and easy
 *   to reason about. The private WebSocket lives alongside it in `ws/` and is
 *   used for account events, not for signal generation.
 * - **`tick()` is a single cycle** and is the unit that tests exercise; `start()`
 *   is just a timer around it.
 */
export class StrategyEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} opts.client
   * @param {import('./OrderGateway.js').OrderGateway} opts.gateway
   * @param {object} opts.strategy  see `strategies/emaCross.js` for the interface
   * @param {string} opts.symbol    `BTCINR` or `BTC-INR`
   * @param {string} [opts.timeframe]
   * @param {number} [opts.pollMs]
   * @param {number} [opts.candleCount] history depth handed to the strategy
   * @param {number} [opts.orderAmount] default size for market signals
   * @param {() => Promise<Array>} [opts.candlesSource] override the client fetch,
   *   used to drive the engine from a feed that already maintains history
   * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable for tests
   */
  constructor(opts) {
    super();
    const { client, gateway, strategy, symbol } = opts;
    if (!client) throw new ValidationError('engine requires a client');
    if (!gateway) throw new ValidationError('engine requires an order gateway');
    if (!strategy?.onCandles) throw new ValidationError('strategy must implement onCandles()');
    if (!symbol) throw new ValidationError('engine requires a symbol');

    this.client = client;
    this.gateway = gateway;
    this.strategy = strategy;
    this.candlesSource = opts.candlesSource ?? null;
    this.symbol = normalizeSymbol(symbol);
    this.timeframe = opts.timeframe ?? '1m';
    this.pollMs = opts.pollMs ?? 5_000;
    this.candleCount = opts.candleCount ?? 200;
    this.orderAmount = opts.orderAmount ?? 0.001;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    this.candles = [];
    /** Open time of the last candle a signal was acted upon. */
    this.lastActedOn = null;
    this.running = false;
    this.ticks = 0;
    this.errors = 0;
    this.lastSignal = null;
    this.startedAt = null;

    // Engine errors are expected operational events (network, strategy bug), not
    // programmer errors. Without a default listener Node rethrows the 'error'
    // event out of the polling loop and kills the process, so install a no-op
    // that callers can supplement with their own 'error' handler.
    this.on('error', () => {});
  }

  /**
   * One poll cycle: refresh history, evaluate the newest *closed* candle, and
   * execute any signal.
   *
   * @param {object} [opts]
   * @param {Array} [opts.candles] supply candles directly instead of fetching
   * @param {number} [opts.now]   injectable clock
   * @returns {Promise<object|null>} the executed signal record, or null
   */
  async tick({ candles, now = Date.now() } = {}) {
    this.ticks += 1;
    const fetched = candles ?? (await this.#fetchCandles());
    const closed = dropFormingCandle(fetched, now);

    if (closed.length === 0) {
      this.emit('skip', { reason: 'no closed candles yet', ticks: this.ticks });
      return null;
    }
    this.candles = closed;

    const newest = closed[closed.length - 1];
    // Same candle already evaluated — nothing new to decide on.
    if (this.lastActedOn !== null && newest.t <= this.lastActedOn) {
      this.emit('skip', { reason: 'no new closed candle', candleTime: newest.t });
      return null;
    }

    const position = this.gateway.positions.get(this.symbol) ?? { qty: 0 };
    const ctx = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      positionQty: position.qty ?? 0,
      orderAmount: this.orderAmount,
      lastPrice: newest.close,
      candles: closed,
    };

    let signal;
    try {
      signal = await this.strategy.onCandles({ candles: closed, ctx });
    } catch (err) {
      this.errors += 1;
      this.emit('error', err);
      // Still advance the cursor: a strategy that throws on every candle must not
      // wedge the loop on the same timestamp forever.
      this.lastActedOn = newest.t;
      return null;
    }

    this.lastActedOn = newest.t;
    if (!signal || signal.action === 'HOLD') {
      this.lastSignal = signal ?? { action: 'HOLD' };
      this.emit('hold', { candleTime: newest.t, reason: signal?.reason });
      return null;
    }

    const executed = await this.#execute(signal, newest);
    return executed;
  }

  /** Translate a strategy signal into a gateway order. */
  async #execute(signal, candle) {
    const side = String(signal.action).toUpperCase();
    const record = {
      candleTime: candle.t,
      signal: { ...signal },
      executed: null,
      error: null,
    };

    try {
      if (side === 'CLOSE') {
        record.executed = await this.gateway.closePosition({ symbol: this.symbol });
      } else if (side === 'BUY' || side === 'SELL') {
        record.executed = await this.gateway.placeOrder({
          symbol: this.symbol,
          side,
          type: signal.type ?? 'MARKET',
          amount: signal.amount ?? this.orderAmount,
          ...(signal.price ? { price: signal.price } : {}),
        });
      } else {
        throw new ValidationError(`unknown strategy action: ${signal.action}`);
      }
    } catch (err) {
      record.error = err;
      this.errors += 1;
      this.emit('error', err);
    }

    this.lastSignal = signal;
    this.emit('signal', record);
    return record;
  }

  async #fetchCandles() {
    if (this.candlesSource) return this.candlesSource();
    return this.client.getKlinesHistory({
      symbol: this.symbol,
      timeframe: this.timeframe,
      count: this.candleCount,
    });
  }

  /** Start the polling loop. Resolves immediately; the loop runs in background. */
  async start({ warmup = true } = {}) {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.emit('start', { symbol: this.symbol, mode: this.gateway.mode, timeframe: this.timeframe });

    if (warmup) {
      // Prime the candle buffer so the strategy has enough history on cycle one.
      try {
        this.candles = await this.#fetchCandles();
        this.emit('warmup', { candles: this.candles.length });
      } catch (err) {
        this.errors += 1;
        this.emit('error', err);
      }
    }

    void this.#loop();
  }

  async #loop() {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.errors += 1;
        this.emit('error', err);
      }
      if (!this.running) break;
      await this.sleep(this.pollMs);
    }
  }

  /** Stop the loop. Any in-flight tick is allowed to finish. */
  stop() {
    this.running = false;
    this.emit('stop', { ticks: this.ticks, errors: this.errors });
  }

  /** Snapshot for the dashboard. */
  status() {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      mode: this.gateway.mode,
      running: this.running,
      ticks: this.ticks,
      errors: this.errors,
      candles: this.candles.length,
      lastCandleTime: this.candles.at(-1)?.t ?? null,
      lastSignal: this.lastSignal,
      position: this.gateway.summary(this.symbol),
      startedAt: this.startedAt,
    };
  }
}

/**
 * Drop the still-forming candle.
 *
 * A candle is "closed" once its end time is in the past. The endpoint returns
 * `endTime` in ms, so compare against the same clock used for polling.
 *
 * @param {Array} candles ascending by open time
 * @param {number} now
 * @returns {Array}
 */
export function dropFormingCandle(candles, now) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  let end = candles.length;
  while (end > 0 && candles[end - 1].endTime > now) end--;
  return candles.slice(0, end);
}
