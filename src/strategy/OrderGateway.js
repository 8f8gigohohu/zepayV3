import { LiveTradingBlockedError, ValidationError } from '../core/errors.js';

/**
 * Snap a float to a fixed number of decimals to stop binary-float noise from
 * accumulating across many fills (e.g. `0.01 - 0.03 === -0.019999999999999997`).
 *
 * @param {number} value
 * @param {number} [decimals] 12 is far finer than any exchange quantity precision
 */
export function quantize(value, decimals = 12) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Order gateway: the single choke point every order passes through.
 *
 * Two modes:
 *
 *   `dry-run` (default) — nothing is transmitted. Orders are validated, priced
 *     against live market data, simulated as immediate fills, and recorded so the
 *     dashboard and logs show exactly what *would* have happened.
 *
 *   `live` — real orders. Reaching this mode requires **two** independent
 *     conditions: `allowLive` (from `ZEBPAY_ALLOW_LIVE=true`) *and* an explicit
 *     `--live` flag at the call site. Either one missing throws
 *     {@link LiveTradingBlockedError}. Belt and braces is deliberate: a stray
 *     env var in a CI container must not be enough to move real money.
 */
export class OrderGateway {
  /**
   * @param {object} opts
   * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} [opts.client]
   * @param {boolean} [opts.allowLive]  environment-level permission
   * @param {boolean} [opts.liveFlag]   explicit caller intent
   * @param {() => number|null} [opts.priceSource] last price for simulated fills
   * @param {(entry:object) => void} [opts.onFill]
   * @param {number} [opts.takerFeeRate] e.g. 0.001 for 0.1%
   */
  constructor(opts = {}) {
    this.client = opts.client ?? null;
    this.allowLive = opts.allowLive ?? false;
    this.liveFlag = opts.liveFlag ?? false;
    this.priceSource = opts.priceSource ?? (() => null);
    this.onFill = opts.onFill;
    this.takerFeeRate = opts.takerFeeRate ?? 0;

    /** @type {Array} simulated fills, newest last */
    this.fills = [];
    /** @type {Map<string, object>} open simulated positions keyed by symbol */
    this.positions = new Map();
    this.nextId = 1;
  }

  /** Effective mode, given both switches. */
  get mode() {
    return this.allowLive && this.liveFlag ? 'live' : 'dry-run';
  }

  get isLive() {
    return this.mode === 'live';
  }

  /**
   * Assert that a live send is permitted. Called by every write method.
   * @throws {LiveTradingBlockedError}
   */
  assertLiveAllowed(action) {
    if (!this.isLive) {
      throw new LiveTradingBlockedError(
        `${action} was requested in dry-run mode. Set ZEBPAY_ALLOW_LIVE=true and pass --live to trade for real.`,
        { action },
      );
    }
    if (!this.client?.isAuthenticated) {
      throw new ValidationError(`${action} requires API credentials`);
    }
  }

  /**
   * Place an order, honouring the current mode.
   *
   * @param {object} order same shape as `client.createOrder`
   * @returns {Promise<object>} a normalised fill/order record
   */
  async placeOrder(order) {
    if (!order?.symbol) throw new ValidationError('order.symbol is required');
    if (!['BUY', 'SELL'].includes(String(order.side).toUpperCase())) {
      throw new ValidationError('order.side must be BUY or SELL');
    }
    if (!(order.amount > 0)) throw new ValidationError('order.amount must be positive');

    if (this.isLive) {
      this.assertLiveAllowed('placeOrder');
      const res = await this.client.createOrder(order);
      const record = {
        mode: 'live',
        clientOrderId: res?.clientOrderId ?? null,
        status: res?.status ?? 'new',
        request: order,
        response: res,
        at: Date.now(),
      };
      this.fills.push(record);
      this.onFill?.(record);
      return record;
    }

    return this.#simulateFill(order);
  }

  /**
   * Simulate an immediate taker fill at the current market price.
   *
   * A dry-run that fills at the signal price would understate cost, so this uses
   * the live last price and applies the taker fee — close enough to judge whether
   * a strategy survives realistic frictions before risking capital.
   */
  #simulateFill(order) {
    const price = this.priceSource();
    if (!(price > 0)) {
      throw new ValidationError(
        'dry-run fill needs a live price; priceSource returned no value. ' +
          'Is the market feed connected for this symbol?',
      );
    }
    const side = String(order.side).toUpperCase();
    const qty = order.amount;
    const notional = price * qty;
    const fee = notional * this.takerFeeRate;

    const record = {
      mode: 'dry-run',
      clientOrderId: `dry-${this.nextId++}`,
      status: 'filled',
      symbol: order.symbol,
      side,
      amount: qty,
      price,
      notional,
      fee,
      request: order,
      at: Date.now(),
    };

    this.#applyToPosition(record);
    this.fills.push(record);
    this.onFill?.(record);
    return record;
  }

  /**
   * Fold a simulated fill into the virtual position book.
   *
   * Three cases, mirroring how an exchange nets a single position per symbol:
   *   1. opening or increasing  -> weighted-average entry price moves toward fill
   *   2. partially reducing     -> entry price unchanged, no PnL realized yet
   *   3. reducing through zero  -> realize PnL on the closed portion, then the
   *                                leftover (if any) is priced at the fill
   */
  #applyToPosition(fill) {
    const key = fill.symbol;
    const pos = this.positions.get(key) ?? {
      symbol: key,
      qty: 0,
      avgPrice: 0,
      realizedPnl: 0,
      fees: 0,
      trades: 0,
    };

    const signed = fill.side === 'BUY' ? fill.amount : -fill.amount;
    const prevQty = pos.qty;
    const newQty = prevQty + signed;

    const opening = prevQty === 0;
    const sameDirection = !opening && Math.sign(signed) === Math.sign(prevQty);
    const reducing = !opening && !sameDirection;

    if (reducing) {
      // PnL is realized on the quantity that was actually closed.
      const closedQty = Math.min(Math.abs(prevQty), Math.abs(signed));
      pos.realizedPnl += (fill.price - pos.avgPrice) * closedQty * Math.sign(prevQty);
    }

    if (opening || sameDirection) {
      const base = Math.abs(prevQty);
      pos.avgPrice =
        (pos.avgPrice * base + fill.price * Math.abs(signed)) / (base + Math.abs(signed));
    } else if (reducing && newQty !== 0 && Math.sign(newQty) !== Math.sign(prevQty)) {
      // Flipped through zero: the residual is a fresh position at the fill price.
      pos.avgPrice = fill.price;
    }

    // Binary floats cannot represent most decimal quantities exactly:
    // 0.01 - 0.03 === -0.019999999999999997. Left alone this drift accumulates
    // over many fills and eventually makes a flat position read as non-zero.
    // 12 decimals is far beyond any exchange's quantity precision, so quantizing
    // removes the noise without discarding real information.
    pos.qty = quantize(newQty);
    pos.avgPrice = quantize(pos.avgPrice);
    pos.realizedPnl = quantize(pos.realizedPnl);
    pos.fees = quantize(pos.fees + fill.fee);
    pos.trades += 1;
    this.positions.set(key, pos);
  }

  /** Unrealised PnL for a simulated position at the current price. */
  unrealizedPnl(symbol) {
    const pos = this.positions.get(symbol);
    if (!pos || pos.qty === 0) return 0;
    const price = this.priceSource();
    if (!(price > 0)) return 0;
    return (price - pos.avgPrice) * pos.qty;
  }

  /**
   * Cancel an order. In dry-run this only records intent, since simulated fills
   * are immediate and there is nothing resting to cancel.
   */
  async cancelOrder(clientOrderId, symbol) {
    if (this.isLive) {
      this.assertLiveAllowed('cancelOrder');
      return this.client.cancelOrder(clientOrderId, symbol);
    }
    const record = { mode: 'dry-run', action: 'cancel', clientOrderId, symbol, at: Date.now() };
    this.fills.push(record);
    this.onFill?.(record);
    return { clientOrderId, status: 'canceled', simulated: true };
  }

  /** Close a position; live path forwards to the API, dry-run flattens locally. */
  async closePosition({ symbol, positionId, price }) {
    if (this.isLive) {
      this.assertLiveAllowed('closePosition');
      return this.client.closePosition({ symbol, positionId });
    }
    const pos = this.positions.get(symbol);
    if (!pos || pos.qty === 0) return { symbol, closed: 0, simulated: true };
    const fill = await this.#simulateFill({
      symbol,
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      amount: Math.abs(pos.qty),
      type: 'MARKET',
    });
    void price;
    return { symbol, closed: fill.amount, realizedPnl: pos.realizedPnl, simulated: true };
  }

  /** Snapshot of the simulated book, for the dashboard. */
  summary(symbol) {
    const pos = this.positions.get(symbol) ?? { symbol, qty: 0, avgPrice: 0, realizedPnl: 0, fees: 0, trades: 0 };
    return {
      mode: this.mode,
      symbol,
      qty: pos.qty,
      avgPrice: pos.avgPrice,
      realizedPnl: pos.realizedPnl - pos.fees,
      unrealizedPnl: this.unrealizedPnl(symbol),
      fees: pos.fees,
      trades: pos.trades,
      fills: this.fills.length,
    };
  }
}
