import { HttpTransport } from '../core/http.js';
import { ValidationError } from '../core/errors.js';
import {
  TIMEFRAME_MS,
  assertTimeframe,
  normalizeSymbol,
  parseKlineRow,
} from '../core/symbols.js';

/**
 * ZebPay Futures REST client.
 *
 * Base URL: `https://futuresbe.zebpay.com`, all routes under `/api/v1`.
 *
 * Public methods need no credentials. Private methods require either an API
 * key/secret pair or a JWT; calling one without credentials throws
 * {@link ValidationError} rather than sending an unauthenticated request that
 * the server would reject opaquely.
 *
 * Scope reminder: writes need `futures:trading`; reads accept
 * `fetch:details` or `futures:trading`.
 */
export class ZebpayFuturesClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.apiSecret]
   * @param {string} [opts.jwt]
   * @param {string} [opts.subaccountId]
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {HttpTransport} [opts.transport] injectable, used by tests
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey ?? '';
    this.apiSecret = opts.apiSecret ?? '';
    this.jwt = opts.jwt ?? '';
    this.subaccountId = opts.subaccountId ?? '';

    this.transport =
      opts.transport ??
      new HttpTransport({
        baseUrl: opts.baseUrl ?? 'https://futuresbe.zebpay.com',
        timeoutMs: opts.timeoutMs ?? 10_000,
        maxRetries: opts.maxRetries ?? 4,
      });
  }

  /** True when credentials sufficient for private REST calls are present. */
  get isAuthenticated() {
    return Boolean((this.apiKey && this.apiSecret) || this.jwt);
  }

  /** Auth descriptor handed to the transport. */
  #auth() {
    if (this.apiKey && this.apiSecret) {
      return { type: 'apiKey', apiKey: this.apiKey, secret: this.apiSecret };
    }
    if (this.jwt) return { type: 'jwt', token: this.jwt };
    throw new ValidationError(
      'This endpoint requires authentication. Set ZEBPAY_API_KEY and ZEBPAY_API_SECRET ' +
        '(with the fetch:details scope for reads, futures:trading for writes), or pass a JWT.',
    );
  }

  #private(method, path, { query, body } = {}) {
    return this.transport.request({
      method,
      path,
      query,
      body,
      auth: this.#auth(),
      subaccountId: this.subaccountId || undefined,
    });
  }

  #public(method, path, { query, body } = {}) {
    return this.transport.request({ method, path, query, body, auth: { type: 'none' } });
  }

  // ── System ────────────────────────────────────────────────────────────────

  /** `GET /api/v1/system/time` -> `{ timestamp }`. Used to detect clock skew. */
  async getServerTime() {
    return await this.#public('GET', '/api/v1/system/time');
  }

  /** `GET /api/v1/system/status` -> `{ systemStatus: 'ok' | 'error' }` */
  async getSystemStatus() {
    return await this.#public('GET', '/api/v1/system/status');
  }

  /**
   * Measure local clock skew against the exchange.
   *
   * Signing uses `Date.now()`, and the server rejects timestamps outside its
   * window, so a badly skewed clock breaks every private call. Returns the
   * offset to add to local time to approximate server time.
   *
   * @returns {Promise<number>} serverTime - localTime, in ms
   */
  async measureClockSkew() {
    const localBefore = Date.now();
    const { timestamp } = await this.getServerTime();
    const localAfter = Date.now();
    const localMid = (localBefore + localAfter) / 2;
    return timestamp - localMid;
  }

  // ── Market (public) ───────────────────────────────────────────────────────

  /** `GET /api/v1/market/markets` -> markets metadata incl. precision and leverage caps. */
  async getMarkets() {
    return await this.#public('GET', '/api/v1/market/markets');
  }

  /**
   * `GET /api/v1/market/orderBook`
   * @param {string} symbol `BTCINR` or `BTC-INR`
   * @returns {Promise<{symbol:string, bids:number[][], asks:number[][], timestamp:number}>}
   */
  async getOrderBook(symbol) {
    return await this.#public('GET', '/api/v1/market/orderBook', {
      query: { symbol: normalizeSymbol(symbol) },
    });
  }

  /**
   * `GET /api/v1/market/ticker24Hr`
   * @param {string} symbol
   */
  async getTicker24Hr(symbol) {
    return await this.#public('GET', '/api/v1/market/ticker24Hr', {
      query: { symbol: normalizeSymbol(symbol) },
    });
  }

  /** `GET /api/v1/market/marketInfo` -> `{ [symbol]: { lastPrice, marketPrice, ... } }` */
  async getMarketInfo() {
    return await this.#public('GET', '/api/v1/market/marketInfo');
  }

  /**
   * `GET /api/v1/market/aggTrade`
   * @param {string} symbol
   * @returns {Promise<Array>} recent aggregate trades, newest last
   */
  async getAggTrades(symbol) {
    return await this.#public('GET', '/api/v1/market/aggTrade', {
      query: { symbol: normalizeSymbol(symbol) },
    });
  }

  /**
   * `POST /api/v1/market/klines` — one page of OHLCV candles.
   *
   * Note the shape: this is a **POST** whose body uses `timeframe` and `since`.
   * There is no `interval`, `startTime` or `endTime`; unknown fields are
   * stripped server-side rather than rejected.
   *
   * @param {object} args
   * @param {string} args.symbol
   * @param {string} [args.timeframe] one of `1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1w 1M`
   * @param {number} [args.since] start time in ms
   * @param {number} [args.limit]
   * @param {'LTP'|'MARK_PRICE'} [args.priceType]
   * @returns {Promise<Array<{t:number,open:number,high:number,low:number,close:number,volume:number,endTime:number}>>}
   */
  async getKlines({ symbol, timeframe = '1m', since, limit, priceType = 'LTP' }) {
    assertTimeframe(timeframe);
    const data = await this.#public('POST', '/api/v1/market/klines', {
      query: { priceType },
      body: {
        symbol: normalizeSymbol(symbol),
        timeframe,
        since,
        limit,
      },
    });
    return Array.isArray(data) ? data.map(parseKlineRow).filter(Boolean) : [];
  }

  /**
   * Walk backwards through kline history to collect roughly `count` candles.
   *
   * The endpoint only accepts a start time (`since`) and a `limit`, with no
   * `endTime`, so deeper history means repeatedly requesting an earlier window
   * and stitching the results together.
   *
   * @param {object} args
   * @param {string} args.symbol
   * @param {string} [args.timeframe]
   * @param {number} [args.count]      total candles wanted
   * @param {number} [args.pageSize]   candles per request (server cap applies)
   * @param {number} [args.until]      newest candle open time; defaults to now
   * @param {string} [args.priceType]
   * @returns {Promise<Array>} candles sorted ascending by open time, de-duplicated
   */
  async getKlinesHistory({
    symbol,
    timeframe = '1h',
    count = 200,
    pageSize = 100,
    until = Date.now(),
    priceType = 'LTP',
  }) {
    assertTimeframe(timeframe);
    const step = TIMEFRAME_MS[timeframe];
    const collected = new Map();
    let cursor = until - step;

    // Hard stop so a bad `step` or an unresponsive cursor can't loop forever.
    for (let guard = 0; guard < 500 && collected.size < count; guard++) {
      const page = await this.getKlines({
        symbol,
        timeframe,
        since: cursor,
        limit: pageSize,
        priceType,
      });
      if (!page.length) break;
      for (const c of page) collected.set(c.t, c);

      const oldest = page[0].t;
      const next = oldest - step;
      if (next >= cursor) break; // cursor not moving -> stop
      cursor = next;
    }

    return [...collected.values()]
      .sort((a, b) => a.t - b.t)
      .slice(Math.max(0, [...collected.values()].length - count));
  }

  // ── Exchange (public) ─────────────────────────────────────────────────────

  /** `GET /api/v1/exchange/tradefee?symbol=` -> `[{ symbol, makerFee, takerFee }]` */
  async getTradeFee(symbol) {
    return await this.#public('GET', '/api/v1/exchange/tradefee', {
      query: { symbol: normalizeSymbol(symbol) },
    });
  }

  /** `GET /api/v1/exchange/tradefees` -> all symbols' maker/taker fees */
  async getTradeFees() {
    return await this.#public('GET', '/api/v1/exchange/tradefees');
  }

  /** `GET /api/v1/exchange/exchangeInfo` -> pairs, filters, precision, leverage */
  async getExchangeInfo() {
    return await this.#public('GET', '/api/v1/exchange/exchangeInfo');
  }

  /** `GET /api/v1/exchange/pairs` -> pair list with status, assets, icons */
  async getPairs() {
    return await this.#public('GET', '/api/v1/exchange/pairs');
  }

  // ── Wallet (private) ──────────────────────────────────────────────────────

  /** `GET /api/v1/wallet/balance` */
  async getWalletBalance() {
    return await this.#private('GET', '/api/v1/wallet/balance');
  }

  // ── Trade: orders (private) ───────────────────────────────────────────────

  /**
   * `POST /api/v1/trade/order` — place an order. Requires `futures:trading`.
   *
   * Order-type rules enforced here so an obviously malformed order fails before
   * consuming a request:
   *   - `MARKET`       — price ignored
   *   - `LIMIT`        — `price` required
   *   - `STOP_MARKET`  — `triggerPrice` required, `price` unused
   *   - `STOP_LIMIT`   — both required, and price must be on the correct side of
   *                      the trigger for the given `side`
   *
   * @param {object} order
   * @param {string} order.symbol
   * @param {number} order.amount    quantity in base asset
   * @param {'BUY'|'SELL'} order.side
   * @param {'MARKET'|'LIMIT'|'STOP_MARKET'|'STOP_LIMIT'} order.type
   * @param {number} [order.price]
   * @param {number} [order.triggerPrice]
   * @param {number} [order.stopLossPrice]
   * @param {number} [order.takeProfitPrice]
   * @param {string} [order.marginAsset] inferred from the symbol when omitted
   */
  async createOrder(order) {
    assertOrderShape(order);
    const { symbol, ...rest } = order;
    return await this.#private('POST', '/api/v1/trade/order', {
      body: { symbol: normalizeSymbol(symbol), ...rest },
    });
  }

  /**
   * `GET /api/v1/trade/order?clientOrderId=`
   * @param {string} clientOrderId
   * @param {string} [symbol]
   */
  async getOrder(clientOrderId, symbol) {
    if (!clientOrderId) throw new ValidationError('clientOrderId is required');
    return await this.#private('GET', '/api/v1/trade/order', {
      query: { clientOrderId, symbol: symbol ? normalizeSymbol(symbol) : undefined },
    });
  }

  /**
   * `PATCH /api/v1/trade/order` — amend an open order. Requires `futures:trading`.
   * @param {object} edit
   * @param {string} edit.clientOrderId
   */
  async editOrder(edit) {
    if (!edit?.clientOrderId) throw new ValidationError('clientOrderId is required');
    return await this.#private('PATCH', '/api/v1/trade/order', { body: { ...edit } });
  }

  /**
   * `DELETE /api/v1/trade/order` — cancel by client order id.
   *
   * The id travels in the **body**, and for API-key auth that body is the signed
   * payload, so this goes through the body-signing path even though it is a
   * DELETE.
   */
  async cancelOrder(clientOrderId, symbol) {
    if (!clientOrderId) throw new ValidationError('clientOrderId is required');
    return await this.#private('DELETE', '/api/v1/trade/order', {
      body: { clientOrderId, symbol: symbol ? normalizeSymbol(symbol) : undefined },
    });
  }

  /** `DELETE /api/v1/trade/order/all` — cancel every open order. */
  async cancelAllOrders() {
    return await this.#private('DELETE', '/api/v1/trade/order/all', { body: {} });
  }

  /**
   * `POST /api/v1/trade/order/addTPSL` — attach one TP or SL to an existing
   * position. Unlike bracket-on-entry, this accepts exactly one trigger.
   */
  async addTpsl({ positionId, symbol, takeProfitPrice, stopLossPrice, ...rest }) {
    const tp = takeProfitPrice !== undefined;
    const sl = stopLossPrice !== undefined;
    if (tp === sl) {
      throw new ValidationError('addTPSL requires exactly one of takeProfitPrice or stopLossPrice');
    }
    if (!positionId) throw new ValidationError('positionId is required');
    return await this.#private('POST', '/api/v1/trade/order/addTPSL', {
      body: {
        positionId,
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
        ...(tp ? { takeProfitPrice } : { stopLossPrice }),
        ...rest,
      },
    });
  }

  /** `GET /api/v1/trade/order/open-orders` */
  async getOpenOrders(symbol) {
    return await this.#private('GET', '/api/v1/trade/order/open-orders', {
      query: { symbol: symbol ? normalizeSymbol(symbol) : undefined },
    });
  }

  /**
   * `GET /api/v1/trade/order/history`
   *
   * `timestamp` doubles as the pagination cursor and must stay inside the auth
   * timestamp window — so paging far back is only possible with JWT auth.
   */
  async getOrderHistory({ symbol, timestamp, limit } = {}) {
    return await this.#private('GET', '/api/v1/trade/order/history', {
      query: {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
        timestamp,
        limit,
      },
    });
  }

  // ── Trade: positions & margin (private) ───────────────────────────────────

  /** `GET /api/v1/trade/positions` */
  async getPositions(symbol) {
    return await this.#private('GET', '/api/v1/trade/positions', {
      query: { symbol: symbol ? normalizeSymbol(symbol) : undefined },
    });
  }

  /** `POST /api/v1/trade/position/close` */
  async closePosition({ positionId, symbol, ...rest }) {
    if (!positionId) throw new ValidationError('positionId is required');
    return await this.#private('POST', '/api/v1/trade/position/close', {
      body: { positionId, symbol: symbol ? normalizeSymbol(symbol) : undefined, ...rest },
    });
  }

  /** `POST /api/v1/trade/addMargin` */
  async addMargin({ positionId, amount, symbol, ...rest }) {
    if (!positionId) throw new ValidationError('positionId is required');
    if (!(amount > 0)) throw new ValidationError('amount must be a positive number');
    return await this.#private('POST', '/api/v1/trade/addMargin', {
      body: { positionId, amount, symbol: symbol ? normalizeSymbol(symbol) : undefined, ...rest },
    });
  }

  /** `POST /api/v1/trade/reduceMargin` */
  async reduceMargin({ positionId, amount, symbol, ...rest }) {
    if (!positionId) throw new ValidationError('positionId is required');
    if (!(amount > 0)) throw new ValidationError('amount must be a positive number');
    return await this.#private('POST', '/api/v1/trade/reduceMargin', {
      body: { positionId, amount, symbol: symbol ? normalizeSymbol(symbol) : undefined, ...rest },
    });
  }

  // ── Trade: leverage (private) ─────────────────────────────────────────────

  /** `GET /api/v1/trade/userLeverage?symbol=` */
  async getUserLeverage(symbol) {
    return await this.#private('GET', '/api/v1/trade/userLeverage', {
      query: { symbol: normalizeSymbol(symbol) },
    });
  }

  /** `GET /api/v1/trade/userLeverages` */
  async getUserLeverages() {
    return await this.#private('GET', '/api/v1/trade/userLeverages');
  }

  /** `POST /api/v1/trade/update/userLeverage` */
  async updateUserLeverage({ symbol, leverage, ...rest }) {
    if (!(leverage > 0)) throw new ValidationError('leverage must be a positive number');
    return await this.#private('POST', '/api/v1/trade/update/userLeverage', {
      body: { symbol: normalizeSymbol(symbol), leverage, ...rest },
    });
  }

  // ── Trade: history (private) ──────────────────────────────────────────────

  /** `GET /api/v1/trade/history` */
  async getTradeHistory({ symbol, timestamp, limit } = {}) {
    return await this.#private('GET', '/api/v1/trade/history', {
      query: {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
        timestamp,
        limit,
      },
    });
  }

  /** `GET /api/v1/trade/transaction/history` */
  async getTransactionHistory({ symbol, timestamp, limit, type } = {}) {
    return await this.#private('GET', '/api/v1/trade/transaction/history', {
      query: {
        symbol: symbol ? normalizeSymbol(symbol) : undefined,
        timestamp,
        limit,
        type,
      },
    });
  }
}

const ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT']);
const SIDES = new Set(['BUY', 'SELL']);

/**
 * Client-side validation mirroring the documented create-order rules.
 * @param {object} o
 */
export function assertOrderShape(o) {
  if (!o || typeof o !== 'object') throw new ValidationError('order object is required');
  if (!o.symbol) throw new ValidationError('order.symbol is required');
  if (!SIDES.has(String(o.side).toUpperCase())) {
    throw new ValidationError(`order.side must be BUY or SELL, received ${o.side}`);
  }
  const type = String(o.type ?? '').toUpperCase();
  if (!ORDER_TYPES.has(type)) {
    throw new ValidationError(
      `order.type must be one of ${[...ORDER_TYPES].join(', ')}, received ${o.type}`,
    );
  }
  if (!(o.amount > 0)) throw new ValidationError('order.amount must be a positive number');

  const side = String(o.side).toUpperCase();
  if ((type === 'LIMIT' || type === 'STOP_LIMIT') && !(o.price > 0)) {
    throw new ValidationError(`${type} orders require a positive price`);
  }
  if ((type === 'STOP_MARKET' || type === 'STOP_LIMIT') && !(o.triggerPrice > 0)) {
    throw new ValidationError(`${type} orders require a positive triggerPrice`);
  }
  if (type === 'STOP_LIMIT') {
    if (side === 'BUY' && o.price < o.triggerPrice) {
      throw new ValidationError('for a BUY STOP_LIMIT, price must be >= triggerPrice');
    }
    if (side === 'SELL' && o.price > o.triggerPrice) {
      throw new ValidationError('for a SELL STOP_LIMIT, price must be <= triggerPrice');
    }
  }
  return true;
}
