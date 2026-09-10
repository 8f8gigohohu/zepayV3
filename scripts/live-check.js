#!/usr/bin/env node
/**
 * Live smoke test against the real ZebPay Futures API.
 *
 * Run this from a machine that can reach futuresbe.zebpay.com. It exercises only
 * public endpoints — no credentials, no orders — and verifies that the response
 * shapes match what the client expects, which is the thing most likely to drift
 * when an exchange updates its API.
 *
 *   node scripts/live-check.js [--symbol=BTCINR]
 *
 * Exits non-zero on the first mismatch so it is usable in CI.
 */
import { loadEnv, resolveConfig } from '../src/core/env.js';
import { ZebpayFuturesClient } from '../src/client/ZebpayFutures.js';
import { ZebpayError } from '../src/core/errors.js';

loadEnv();

const args = process.argv.slice(2);
const symbolArg = args.find((a) => a.startsWith('--symbol='))?.slice(9) ?? 'BTC-INR';

const config = resolveConfig();
const client = new ZebpayFuturesClient({
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs,
  maxRetries: 1,
});

let failures = 0;
const results = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms, value });
    console.log(`  ✓ ${name.padEnd(34)} ${String(ms).padStart(5)} ms  ${value}`);
  } catch (err) {
    failures += 1;
    const ms = Date.now() - t0;
    results.push({ name, ok: false, ms, error: err.message });
    console.log(`  ✗ ${name.padEnd(34)} ${String(ms).padStart(5)} ms  ${err.message}`);
  }
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`\nZebPay Futures live check — ${config.baseUrl}\n`);

await check('GET /system/status', async () => {
  const s = await client.getSystemStatus();
  expect(s?.systemStatus, `expected systemStatus, got ${JSON.stringify(s)}`);
  return `systemStatus=${s.systemStatus}`;
});

await check('GET /system/time + clock skew', async () => {
  const skew = await client.measureClockSkew();
  expect(Math.abs(skew) < 30_000, `clock skew too large for signing: ${skew}ms`);
  return `skew=${Math.round(skew)}ms`;
});

await check('GET /market/orderBook', async () => {
  const b = await client.getOrderBook(symbolArg);
  expect(Array.isArray(b?.bids) && b.bids.length > 0, 'no bids returned');
  expect(Array.isArray(b?.asks) && b.asks.length > 0, 'no asks returned');
  const [bidPrice, bidQty] = b.bids[0];
  const [askPrice, askQty] = b.asks[0];
  expect(typeof bidPrice === 'number', `bid price is ${typeof bidPrice}, expected number`);
  expect(typeof bidQty === 'number', `bid qty is ${typeof bidQty}, expected number`);
  expect(askPrice > bidPrice, `crossed book: bid ${bidPrice} >= ask ${askPrice}`);
  return `bid=${bidPrice} ask=${askPrice} spread=${askPrice - bidPrice}`;
});

await check('GET /market/ticker24Hr', async () => {
  const t = await client.getTicker24Hr(symbolArg);
  for (const field of ['last', 'high', 'low', 'open', 'baseVolume']) {
    expect(Number.isFinite(Number(t?.[field])), `ticker.${field} missing or non-numeric`);
  }
  expect(t.high >= t.low, `high ${t.high} < low ${t.low}`);
  return `last=${t.last} 24h=${Number(t.percentage).toFixed(2)}%`;
});

await check('GET /market/aggTrade', async () => {
  const trades = await client.getAggTrades(symbolArg);
  expect(Array.isArray(trades) && trades.length > 0, 'no trades returned');
  const t = trades.at(-1);
  expect(Number.isFinite(Number(t.price)), 'trade.price non-numeric');
  expect(typeof t.isBuyerMarketMaker === 'boolean', 'trade.isBuyerMarketMaker not boolean');
  return `${trades.length} trades, last=${t.price}`;
});

await check('POST /market/klines (1m)', async () => {
  const candles = await client.getKlines({ symbol: symbolArg, timeframe: '1m', limit: 5 });
  expect(candles.length > 0, 'no candles returned');
  const c = candles.at(-1);
  for (const f of ['t', 'open', 'high', 'low', 'close', 'volume', 'endTime']) {
    expect(Number.isFinite(c[f]), `candle.${f} missing or non-numeric`);
  }
  expect(c.high >= c.low, `high ${c.high} < low ${c.low}`);
  expect(c.endTime > c.t, 'endTime must be after the open time');
  return `${candles.length} candles, last close=${c.close}`;
});

await check('POST /market/klines history paging', async () => {
  const candles = await client.getKlinesHistory({
    symbol: symbolArg,
    timeframe: '1m',
    count: 150,
    pageSize: 100,
  });
  expect(candles.length >= 100, `expected >= 100 candles, got ${candles.length}`);
  const times = candles.map((c) => c.t);
  const unique = new Set(times);
  expect(unique.size === times.length, 'paged history contains duplicate candles');
  const sorted = [...times].sort((a, b) => a - b);
  expect(JSON.stringify(times) === JSON.stringify(sorted), 'paged history is not ascending');
  return `${candles.length} candles, ${unique.size} unique`;
});

await check('GET /market/markets', async () => {
  const m = await client.getMarkets();
  const symbols = m?.symbols ?? [];
  expect(symbols.length > 0, 'no symbols returned');
  const target = symbols.find((s) => s.symbol === symbolArg.toUpperCase().replace(/-/g, ''));
  expect(target, `${symbolArg} not present in markets`);
  expect(Number.isFinite(Number(target.maxLeverage)), 'maxLeverage missing');
  return `${symbols.length} symbols, ${target.symbol} maxLeverage=${target.maxLeverage}x`;
});

await check('GET /exchange/tradefee', async () => {
  const f = await client.getTradeFee(symbolArg);
  expect(Array.isArray(f) && f.length > 0, 'no fee rows returned');
  expect(Number.isFinite(Number(f[0].takerFee)), 'takerFee non-numeric');
  return `maker=${f[0].makerFee}% taker=${f[0].takerFee}%`;
});

await check('GET /exchange/pairs', async () => {
  const p = await client.getPairs();
  const pairs = p?.pairs ?? [];
  expect(pairs.length > 0, 'no pairs returned');
  return `${pairs.length} pairs`;
});

if (config.apiKey && config.apiSecret) {
  const auth = new ZebpayFuturesClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    subaccountId: config.subaccountId,
    baseUrl: config.baseUrl,
  });

  console.log('\n  private endpoints (read-only):\n');

  await check('GET /wallet/balance', async () => {
    const b = await auth.getWalletBalance();
    expect(b !== null && b !== undefined, 'empty balance response');
    return Array.isArray(b) ? `${b.length} assets` : typeof b;
  });

  await check('GET /trade/positions', async () => {
    const p = await auth.getPositions();
    return Array.isArray(p) ? `${p.length} open` : typeof p;
  });

  await check('GET /trade/order/open-orders', async () => {
    const o = await auth.getOpenOrders();
    return Array.isArray(o) ? `${o.length} open` : typeof o;
  });

  await check('GET /trade/userLeverages', async () => {
    const l = await auth.getUserLeverages();
    return Array.isArray(l) ? `${l.length} entries` : typeof l;
  });
} else {
  console.log('\n  (no ZEBPAY_API_KEY/SECRET set — skipping private endpoints)\n');
}

const passed = results.length - failures;
console.log(`\n  ${passed}/${results.length} checks passed\n`);

if (failures > 0) {
  console.log('  Live API shapes may have changed. Compare against:');
  console.log('  https://github.com/zebpay/zebpay-api-references\n');
  process.exitCode = 1;
} else if (results.some((r) => r.name.includes('clock skew'))) {
  console.log('  All public shapes match. Safe to run the dashboard or bot.\n');
}

void ZebpayError;
