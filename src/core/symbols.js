import { ValidationError } from './errors.js';

/**
 * Symbol handling.
 *
 * The ZebPay web UI addresses pairs with a dash (`BTC-INR`, as in
 * zebpay.com/futures/trade/BTC-INR) while the Futures REST API uses the
 * concatenated form (`BTCINR`). Accepting both — and normalising to the API
 * form — removes a whole class of "symbol not found" errors.
 */

/** @param {string} input @returns {string} API-form symbol, e.g. `BTCINR` */
export function normalizeSymbol(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ValidationError('symbol is required');
  }
  const s = input.trim().toUpperCase().replace(/[-_\s]/g, '');
  if (!/^[A-Z0-9]+$/.test(s)) {
    throw new ValidationError(`invalid symbol: ${input}`);
  }
  return s;
}

/**
 * Split an API-form symbol into base/quote using a known quote-asset list.
 *
 * Without the quote list this is ambiguous (`BTCINR` could be BTC/INR or
 * BTCIN/R), so callers that need the split should pass the supported quotes
 * discovered from `/api/v1/exchange/pairs`.
 *
 * @param {string} input
 * @param {string[]} [quotes] e.g. `['INR','USDT']`
 * @returns {{base:string, quote:string}|null}
 */
export function splitSymbol(input, quotes = ['USDT', 'INR']) {
  const s = normalizeSymbol(input);
  const ordered = [...quotes].sort((a, b) => b.length - a.length);
  for (const q of ordered) {
    if (s.endsWith(q) && s.length > q.length) {
      return { base: s.slice(0, -q.length), quote: q };
    }
  }
  return null;
}

/** `BTCINR` -> `BTC-INR` (UI form). @param {string} input */
export function toDisplaySymbol(input) {
  const split = splitSymbol(input);
  return split ? `${split.base}-${split.quote}` : normalizeSymbol(input);
}

/** Kline timeframes accepted by `POST /api/v1/market/klines`. */
export const KLINE_TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '1w', '1M',
];

/** Milliseconds per timeframe, used to page backwards through history. */
export const TIMEFRAME_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000, // 30 days — only used for rough paging
};

/**
 * Validate a kline request before it is sent.
 *
 * The endpoint silently strips unknown body fields, so a typo like `interval`
 * instead of `timeframe` would not error — it would quietly return 1m candles.
 * Validating client-side turns that silent wrong answer into a loud failure.
 */
export function assertTimeframe(timeframe) {
  if (!KLINE_TIMEFRAMES.includes(timeframe)) {
    throw new ValidationError(
      `unsupported timeframe "${timeframe}". Allowed: ${KLINE_TIMEFRAMES.join(', ')}`,
    );
  }
  return timeframe;
}

/**
 * Parse a raw kline row into a typed candle.
 *
 * Rows are positional arrays:
 *   [startTime, open, high, low, close, volume, endTime]
 * Prices and volumes arrive as strings and are converted to numbers.
 *
 * @param {Array} row
 * @returns {{t:number,open:number,high:number,low:number,close:number,volume:number,endTime:number}|null}
 */
export function parseKlineRow(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [t, open, high, low, close, volume, endTime] = row;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : NaN;
  };
  return { t, open: n(open), high: n(high), low: n(low), close: n(close), volume: n(volume), endTime };
}
