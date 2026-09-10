import { normalizeSymbol } from '../core/symbols.js';

/**
 * Market scanner.
 *
 * Discovers the tradable universe **from the exchange** rather than a hard-coded
 * list, then filters it down to symbols worth analysing. Scanning 60+ symbols
 * every cycle would burn the rate limit for no benefit, so eligibility is
 * cheap and REST-only.
 *
 * Eligibility criteria, all configurable:
 *   - pair is `Open` / active
 *   - quote asset matches (INR by default — this is a ZebPay-only product)
 *   - maximum leverage is at least the minimum the strategy needs
 *   - optional allow/deny list for operators who want to restrict the universe
 */

export const DEFAULT_UNIVERSE_FILTER = {
  quoteAssets: ['INR'],
  requiredStatus: ['Open', 'OPEN', 'active', 'ACTIVE'],
  minLeverage: 2,
  allowList: null,   // null = no restriction
  denyList: [],
  maxSymbols: 60,
};

/**
 * Build the eligible universe from `/api/v1/market/markets`.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} [args.filter]
 * @returns {Promise<Array<{symbol:string, base:string, quote:string, maxLeverage:number, pricePrecision:number, quantityPrecision:number, makerFee:number, takerFee:number}>>}
 */
export async function discoverUniverse({ client, filter = {} }) {
  const f = { ...DEFAULT_UNIVERSE_FILTER, ...filter };
  const markets = await client.getMarkets();
  const symbols = markets?.symbols ?? [];

  const deny = new Set((f.denyList ?? []).map((s) => normalizeSymbol(s)));
  const allow = f.allowList ? new Set(f.allowList.map((s) => normalizeSymbol(s))) : null;
  const quotes = new Set(f.quoteAssets.map((q) => q.toUpperCase()));
  const statuses = new Set(f.requiredStatus);

  const eligible = [];
  for (const m of symbols) {
    const symbol = normalizeSymbol(m.symbol);
    if (allow && !allow.has(symbol)) continue;
    if (deny.has(symbol)) continue;
    if (!quotes.has(String(m.quoteAsset ?? '').toUpperCase())) continue;
    if (!statuses.has(String(m.status ?? ''))) continue;
    if (Number(m.maxLeverage ?? 0) < f.minLeverage) continue;

    eligible.push({
      symbol,
      base: m.baseAsset ?? symbol,
      quote: m.quoteAsset ?? '',
      maxLeverage: Number(m.maxLeverage ?? 0),
      pricePrecision: Number(m.pricePrecision ?? 0),
      quantityPrecision: Number(m.quantityPrecision ?? 0),
      makerFee: Number(m.makerFee ?? 0),
      takerFee: Number(m.takerFee ?? 0),
      status: m.status,
    });
  }

  // Deterministic order so scans are reproducible and diffable.
  eligible.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return eligible.slice(0, f.maxSymbols);
}

/**
 * Fetch candles + order book for one symbol, with a freshness stamp.
 *
 * `dataAgeMs` is what the risk engine and kill switch use to refuse decisions
 * made on stale data — the single most common way an automated system loses
 * money in a fast market.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {string} args.symbol
 * @param {string} [args.timeframe]
 * @param {number} [args.candleCount]
 * @param {boolean} [args.withBook]
 * @param {() => number} [args.now]
 */
export async function fetchSymbolData({
  client,
  symbol,
  timeframe = '5m',
  candleCount = 120,
  withBook = true,
  now = Date.now,
}) {
  const sym = normalizeSymbol(symbol);
  const candles = await client.getKlinesHistory({
    symbol: sym,
    timeframe,
    count: candleCount,
  });

  let book = null;
  if (withBook) {
    try {
      book = await client.getOrderBook(sym);
    } catch {
      // A missing book is not fatal: the AI records it as an unknown factor and
      // the risk engine can still reject on liquidity. Silently substituting a
      // fake book would be far worse.
      book = null;
    }
  }

  const last = candles.at(-1);
  const dataAgeMs = last ? now() - last.endTime : null;

  return { symbol: sym, candles, book, dataAgeMs };
}

/**
 * Cheap pre-rank using only the 24h ticker, for the dashboard's live table.
 *
 * One request per symbol is still a lot, so this is opt-in and bounded.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {Array<{symbol:string}>} args.universe
 * @param {number} [args.limit]
 */
export async function rankByTicker({ client, universe, limit = 25 }) {
  const rows = [];
  for (const { symbol } of universe.slice(0, limit)) {
    try {
      const t = await client.getTicker24Hr(symbol);
      rows.push({
        symbol,
        lastPrice: Number(t.last ?? t.close ?? 0),
        changePct: Number(t.percentage ?? 0),
        high: Number(t.high ?? 0),
        low: Number(t.low ?? 0),
        volume: Number(t.baseVolume ?? 0),
        spreadBps: t.bid && t.ask ? ((Number(t.ask) - Number(t.bid)) / Number(t.bid)) * 10_000 : null,
      });
    } catch (err) {
      rows.push({ symbol, error: err.message });
    }
  }
  // Most active first — volume is the cheapest proxy for tradability.
  rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  return rows;
}
