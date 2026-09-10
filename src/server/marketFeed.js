import { EventEmitter } from 'node:events';
import { normalizeSymbol } from '../core/symbols.js';

/**
 * Polls ZebPay public market data and keeps a fresh snapshot in memory.
 *
 * REST polling rather than the market WebSocket, for two reasons: the documented
 * futures *market* socket host (`futuresws.zebpay.com`) differs from the private
 * one (`sp-futuresws.zebpay.com`) and its stream names are not covered by the
 * same reference, and polling keeps the dashboard dependency-free. The private
 * Socket.IO stream is implemented separately in `ws/PrivateStream.js`.
 *
 * One poll cycle refreshes ticker + order book + recent trades together, so the
 * dashboard never renders a half-updated view.
 */
export class MarketFeed extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} opts.client
   * @param {string} opts.symbol
   * @param {number} [opts.intervalMs]
   * @param {() => number} [opts.now] injectable clock
   */
  constructor({ client, symbol, intervalMs = 2_000, now = Date.now }) {
    super();
    this.client = client;
    this.symbol = normalizeSymbol(symbol);
    this.intervalMs = intervalMs;
    this.now = now;

    this.ticker = null;
    this.orderBook = null;
    this.trades = [];
    this.candles = [];
    this.lastPrice = null;
    this.updatedAt = null;
    this.lastError = null;
    this.polls = 0;
    this.failures = 0;
    this.timer = null;

    // A feed error is an expected operational condition (upstream down, bad
    // symbol), not a programmer error. Node rethrows an 'error' event that has
    // no listener, which would turn a transient network blip into a crash for
    // any caller that only cares about the snapshot. Default to a no-op; callers
    // who want to observe failures add their own 'error' listener.
    this.on('error', () => {});
  }

  /** Fetch everything once. Returns true on success. */
  async refresh() {
    this.polls += 1;
    try {
      const [ticker, orderBook, trades] = await Promise.all([
        this.client.getTicker24Hr(this.symbol),
        this.client.getOrderBook(this.symbol),
        this.client.getAggTrades(this.symbol).catch(() => []),
      ]);
      this.ticker = ticker;
      this.orderBook = orderBook;
      this.trades = Array.isArray(trades) ? trades : [];
      this.lastPrice = Number(ticker?.last ?? ticker?.close ?? null);
      this.updatedAt = this.now();
      this.lastError = null;
      this.emit('update', this.snapshot());
      return true;
    } catch (err) {
      this.failures += 1;
      this.lastError = err.message;
      this.emit('error', err);
      return false;
    }
  }

  /** Load candle history once (and on demand when the interval changes). */
  async loadCandles(timeframe = '1m', count = 200) {
    const rows = await this.client.getKlines({
      symbol: this.symbol,
      timeframe,
      limit: count,
      since: this.now() - approximateMs(timeframe, count),
    });
    this.candles = rows;
    return rows;
  }

  async start() {
    if (this.timer) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // Do not hold the event loop open for the poll timer alone.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {number} [levels] depth per side */
  snapshot(levels = 20) {
    const bids = (this.orderBook?.bids ?? []).slice(0, levels);
    const asks = (this.orderBook?.asks ?? []).slice(0, levels);
    const bestBid = bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.[0] ?? null;
    return {
      symbol: this.symbol,
      lastPrice: this.lastPrice,
      ticker: this.ticker,
      bids,
      asks,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      spreadPct:
        bestBid !== null && bestAsk !== null && bestBid > 0
          ? ((bestAsk - bestBid) / bestBid) * 100
          : null,
      trades: this.trades.slice(-30).reverse(),
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      polls: this.polls,
      failures: this.failures,
    };
  }
}

/**
 * Deterministic synthetic feed used when the live upstream is unreachable.
 *
 * The dashboard is meant to be demonstrable without credentials or network, so
 * rather than showing a blank screen this generates a plausible random walk from
 * a recorded BTC-INR snapshot and labels itself clearly as demo data. It is never
 * wired to the order gateway in a way that could place a real order — the
 * gateway stays in dry-run.
 */
export class DemoMarketFeed extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.symbol]
   * @param {number} [opts.startPrice] last price from a recorded snapshot
   * @param {number} [opts.intervalMs]
   * @param {() => number} [opts.random] injectable for deterministic tests
   * @param {() => number} [opts.now]
   */
  constructor({
    symbol = 'BTCINR',
    startPrice = 7_478_663,
    intervalMs = 1_000,
    candleMs = 5_000,
    random = Math.random,
    now = Date.now,
  }) {
    super();
    this.symbol = normalizeSymbol(symbol);
    this.price = startPrice;
    this.openPrice = startPrice;
    this.high = startPrice;
    this.low = startPrice;
    this.volume = 0;
    this.intervalMs = intervalMs;
    this.candleMs = candleMs;
    this.random = random;
    this.now = now;
    this.candles = seedCandles(startPrice, 180, random, candleMs);
    this.timer = null;
    this.polls = 0;
    this.failures = 0;
    this.updatedAt = null;
    this.trades = [];
  }

  #step() {
    // Mean-reverting random walk: ~0.05% per tick.
    const drift = (this.random() - 0.5) * 0.001 * this.price;
    this.price = Math.max(1, this.price + drift);
    this.high = Math.max(this.high, this.price);
    this.low = Math.min(this.low, this.price);
    const qty = Number((this.random() * 0.05 + 0.001).toFixed(4));
    this.volume += qty;
    this.trades.push({
      aggregateTradeId: this.trades.length + 1,
      symbol: this.symbol,
      price: this.price.toFixed(0),
      quantity: String(qty),
      tradeTime: this.now(),
      isBuyerMarketMaker: this.random() > 0.5,
    });
    if (this.trades.length > 200) this.trades.shift();
    this.#rollCandle();
  }

  /**
   * Advance the candle series so the chart and the strategy engine see history
   * that actually progresses. A candle is closed once `candleMs` has elapsed and
   * a new one opened at the current price.
   */
  #rollCandle() {
    const now = this.now();
    const cur = this.candles[this.candles.length - 1];
    if (!cur || now > cur.endTime) {
      const t = cur ? cur.endTime + 1 : now;
      this.candles.push({
        t,
        open: this.price,
        high: this.price,
        low: this.price,
        close: this.price,
        volume: 0,
        endTime: t + this.candleMs - 1,
      });
    } else {
      cur.high = Math.max(cur.high, this.price);
      cur.low = Math.min(cur.low, this.price);
      cur.close = this.price;
      cur.volume += 0.01;
    }
    // Bound memory: the dashboard only ever renders the last few hundred.
    if (this.candles.length > 400) this.candles.splice(0, this.candles.length - 400);
  }

  async refresh() {
    this.polls += 1;
    this.#step();
    this.updatedAt = this.now();
    this.emit('update', this.snapshot());
    return true;
  }

  /** Mirrors `MarketFeed.lastPrice` so callers can treat both feeds alike. */
  get lastPrice() {
    return this.price;
  }

  /** Returns the maintained series so the chart and engine stay consistent. */
  async loadCandles(timeframe = '1m', count = 180) {
    void timeframe;
    return this.candles.slice(-count);
  }

  async start() {
    if (this.timer) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(levels = 20) {
    const bids = [];
    const asks = [];
    for (let i = 0; i < levels; i++) {
      const tick = 10 + i * 10;
      bids.push([Math.round(this.price - tick), Number((this.random() * 3 + 0.01).toFixed(3))]);
      asks.push([Math.round(this.price + tick), Number((this.random() * 3 + 0.01).toFixed(3))]);
    }
    const change = this.price - this.openPrice;
    return {
      symbol: this.symbol,
      demo: true,
      lastPrice: this.price,
      ticker: {
        symbol: this.symbol,
        last: this.price,
        open: this.openPrice,
        high: this.high,
        low: this.low,
        change,
        percentage: (change / this.openPrice) * 100,
        baseVolume: this.volume,
      },
      bids,
      asks,
      spread: 20,
      spreadPct: (20 / this.price) * 100,
      trades: this.trades.slice(-30).reverse(),
      updatedAt: this.updatedAt,
      lastError: null,
      polls: this.polls,
      failures: this.failures,
    };
  }
}

/** Build synthetic ascending candles ending near `endPrice`. */
function seedCandles(endPrice, count, random, candleMs = 5_000) {
  const out = [];
  let price = endPrice * 0.98;
  const t0 = Date.now() - count * candleMs;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = Math.max(1, open * (1 + (random() - 0.5) * 0.004));
    const high = Math.max(open, close) * (1 + random() * 0.001);
    const low = Math.min(open, close) * (1 - random() * 0.001);
    out.push({
      t: t0 + i * candleMs,
      open,
      high,
      low,
      close,
      volume: Number((random() * 5 + 0.1).toFixed(3)),
      endTime: t0 + (i + 1) * candleMs - 1,
    });
    price = close;
  }
  return out;
}

/** Rough ms span for `count` candles — only used to bound a `since` window. */
function approximateMs(timeframe, count) {
  const table = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
    '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '1w': 604_800_000,
  };
  const step = table[timeframe] ?? 60_000;
  return step * count * 1.5;
}
