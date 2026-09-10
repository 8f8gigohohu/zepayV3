import { buildFeed, createDashboardServer } from '../server/app.js';
import { envInt, envStr } from '../core/env.js';

/**
 * Start the dashboard.
 *
 * Prefers live ZebPay data and falls back to the synthetic demo feed when the
 * upstream cannot be reached, so the UI is never a blank screen. The feed's mode
 * is reported on startup and surfaced in the UI banner.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 */
export async function startDashboard({ client, config, flags }) {
  const symbol = flags.symbol ?? envStr('ZEBPAY_DASHBOARD_SYMBOL', 'BTCINR');
  const port = Number(flags.port ?? envInt('PORT', 4173));
  const forceDemo = flags.demo === true;

  process.stdout.write(`starting dashboard for ${symbol}…\n`);
  const { feed, mode, reason } = await buildFeed({ client, symbol, forceDemo });

  if (mode === 'demo') {
    process.stdout.write(
      `⚠ live upstream unavailable (${reason ?? 'unknown'}); using synthetic demo data.\n` +
        `  The dashboard will be labelled as demo and no real prices are shown.\n`,
    );
  } else {
    process.stdout.write(`✓ connected to ${config.baseUrl}\n`);
  }

  await feed.start();
  // Prime candle history so the chart renders immediately.
  try {
    await feed.loadCandles('1m', 180);
  } catch (err) {
    process.stdout.write(`  (candles not loaded: ${err.message})\n`);
  }

  // Optionally run the strategy engine in the same process so the dashboard can
  // report live bot state instead of "idle". Still dry-run unless both live
  // switches are set.
  let engine = null;
  if (flags.bot === true) {
    const { buildEngine } = await import('./engine-factory.js');
    engine = buildEngine({ client, config, flags, feed, feedMode: mode });
    engine.on('signal', (r) =>
      process.stdout.write(`  [bot] ${r.signal.action} — ${r.signal.reason}\n`),
    );
    engine.on('error', (e) => process.stdout.write(`  [bot] error: ${e.message}\n`));
    await engine.start();
  }

  const server = createDashboardServer({ feed, engine, symbol, mode });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0 so the server is reachable from outside the container (proxied previews).
    server.listen(port, '0.0.0.0', resolve);
  });

  const addr = server.address();
  process.stdout.write(`\n  dashboard  http://localhost:${addr.port}\n`);
  process.stdout.write(`  data mode  ${mode}\n`);
  process.stdout.write(`  stream     GET /api/stream (SSE)\n\n`);

  const shutdown = () => {
    feed.stop();
    server.close(() => process.exit(0));
    // Force-exit if a keep-alive connection holds the server open.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
