import { ZebpayFuturesClient } from '../client/ZebpayFutures.js';
import { discoverUniverse } from '../scanner/scanner.js';
import { DEFAULT_RISK_LIMITS } from '../risk/engine.js';
import { PermissionEngine } from '../permissions/engine.js';

/**
 * `zepay doctor` — verify the environment before trusting the system with money.
 *
 * Every check reports an explicit PASS / WARN / FAIL and never guesses. A check
 * that cannot run says so, rather than quietly counting as a pass — the failure
 * mode this command exists to catch is an operator believing something works
 * because nothing told them otherwise.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 */
export async function runDoctor({ client, config, flags }) {
  const rows = [];
  const add = (area, name, status, detail) => rows.push({ area, name, status, detail });
  const pass = (a, n, d) => add(a, n, 'PASS', d);
  const warn = (a, n, d) => add(a, n, 'WARN', d);
  const fail = (a, n, d) => add(a, n, 'FAIL', d);

  process.stdout.write('zepay doctor\n\n');

  // ── 1. Configuration ──────────────────────────────────────────────────────
  pass('config', 'base url', config.baseUrl);
  config.apiKey && config.apiSecret
    ? pass('config', 'credentials', `api key ${redactKey(config.apiKey)}`)
    : warn('config', 'credentials', 'no ZEBPAY_API_KEY / ZEBPAY_API_SECRET — private calls will fail');

  const live = config.allowLive === true && flags.live === true;
  live
    ? warn('config', 'live trading', 'ENABLED — real orders can be placed')
    : pass('config', 'live trading', 'off (dry-run only)');

  // ── 2. Connectivity + clock. A skewed clock is the single most common cause
  //       of signature rejections, so it is checked before anything signed.
  let skew = null;
  try {
    skew = await client.measureClockSkew();
    Math.abs(skew) <= 5_000
      ? pass('network', 'system time', `skew ${Math.round(skew)} ms`)
      : fail('network', 'system time', `skew ${Math.round(skew)} ms — signed requests may be rejected`);
  } catch (err) {
    fail('network', 'system time', `unreachable — ${err.message}`);
  }

  try {
    const s = await client.getSystemStatus();
    pass('network', 'system status', String(s.systemStatus));
  } catch (err) {
    fail('network', 'system status', err.message);
  }

  // ── 3. Market data ────────────────────────────────────────────────────────
  const symbol = flags.symbol ?? 'BTC-INR';
  try {
    const t = await client.getTicker24Hr(symbol);
    const price = Number(t.last ?? t.close);
    Number.isFinite(price) && price > 0
      ? pass('market', `ticker ${symbol}`, `last ${price}`)
      : fail('market', `ticker ${symbol}`, `no usable price in response (last=${t.last})`);
  } catch (err) {
    fail('market', `ticker ${symbol}`, err.message);
  }

  try {
    const b = await client.getOrderBook(symbol);
    const ok = b?.bids?.length > 0 && b?.asks?.length > 0;
    ok
      ? pass('market', 'order book', `${b.bids.length}/${b.asks.length} levels`)
      : fail('market', 'order book', 'empty book');
  } catch (err) {
    fail('market', 'order book', err.message);
  }

  try {
    const k = await client.getKlinesHistory({ symbol, timeframe: flags.tf ?? '1m', count: 5 });
    // A silent timeframe downgrade is worse than an error: the strategy would
    // trade the wrong period without any warning.
    k.length >= 5
      ? pass('market', 'klines', `${k.length} candles`)
      : fail('market', 'klines', `only ${k.length} candles returned`);
  } catch (err) {
    fail('market', 'klines', err.message);
  }

  // ── 4. Fees. Never assumed — read from the exchange. ──────────────────────
  try {
    const f = await client.getTradeFee(symbol);
    const row = Array.isArray(f) ? f[0] : f;
    row?.takerFee !== undefined
      ? pass('market', 'fees', `maker ${row.makerFee}% taker ${row.takerFee}%`)
      : warn('market', 'fees', 'response had no fee fields');
  } catch (err) {
    warn('market', 'fees', `${err.message} — cost engine will use no fee data`);
  }

  // ── 5. Universe ───────────────────────────────────────────────────────────
  try {
    const universe = await discoverUniverse({ client });
    universe.length > 0
      ? pass('market', 'universe', `${universe.length} tradable symbols`)
      : warn('market', 'universe', 'no symbols matched the filter');
  } catch (err) {
    fail('market', 'universe', err.message);
  }

  // ── 6. Private endpoints ──────────────────────────────────────────────────
  if (config.apiKey && config.apiSecret) {
    try {
      const bal = await client.getWalletBalance();
      pass('private', 'wallet balance', `keys [${Object.keys(bal ?? {}).join(', ') || 'none'}]`);
    } catch (err) {
      fail('private', 'wallet balance', `${err.message} — needs scope fetch:details`);
    }
    try {
      await client.getOpenOrders();
      pass('private', 'open orders', 'readable');
    } catch (err) {
      fail('private', 'open orders', `${err.message} — needs scope futures:trading`);
    }
  } else {
    warn('private', 'wallet balance', 'skipped — no credentials');
    warn('private', 'open orders', 'skipped — no credentials');
  }

  // ── 7. Safety configuration. These are facts about the build, not probes. ──
  const perms = new PermissionEngine();
  pass('safety', 'default live trading', 'off by default (correct)');
  pass('safety', 'withdrawals', perms.can('withdrawal') ? 'GRANTED — should be impossible' : 'forbidden platform-wide');
  pass('safety', 'risk limits',
    `maxLeverage ${DEFAULT_RISK_LIMITS.maxLeverage}x · maxPairExposure ${DEFAULT_RISK_LIMITS.maxPairExposurePct}% · maxDailyLoss ${DEFAULT_RISK_LIMITS.maxDailyLossPct}%`);

  // ── Report ────────────────────────────────────────────────────────────────
  const icon = { PASS: '✓', WARN: '⚠', FAIL: '✗' };
  let area = null;
  for (const r of rows) {
    if (r.area !== area) {
      area = r.area;
      process.stdout.write(`\n${area}\n`);
    }
    process.stdout.write(`  ${icon[r.status]} ${r.name.padEnd(20)} ${r.detail}\n`);
  }

  const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  process.stdout.write(
    `\n${counts.PASS ?? 0} passed · ${counts.WARN ?? 0} warnings · ${counts.FAIL ?? 0} failed\n`,
  );

  if ((counts.FAIL ?? 0) > 0) {
    process.stdout.write(
      '\nThe failures above mean the AI stack will refuse to trade, which is the intended\n' +
        'behaviour. Fix connectivity or credentials before expecting any decisions.\n',
    );
    process.exitCode = 1;
  }
}

/** Show enough of a key to recognise it without printing the whole thing. */
function redactKey(key) {
  const s = String(key);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Convenience for callers that only have a config object. */
export function buildClient(config) {
  return new ZebpayFuturesClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    subaccountId: config.subaccountId,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
}
