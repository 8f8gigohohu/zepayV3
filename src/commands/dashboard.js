import { buildFeed, createDashboardServer } from '../server/app.js';
import { envInt, envNum, envStr } from '../core/env.js';

/**
 * Start the dashboard.
 *
 * Startup order matters here. The HTTP server binds **before** any market data
 * is fetched, so a slow or unreachable upstream can never stop the page from
 * opening. Feed polling, candle history, bot warm-up and clock-skew measurement
 * all continue in the background and report into the UI as they land.
 *
 * The only bounded wait is the initial upstream probe, which decides LIVE vs
 * DEMO. It is capped so a hung connection degrades to demo after a few seconds
 * instead of blocking indefinitely.
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
  const probeTimeoutMs = Number(flags.probeTimeoutMs ?? envNum('ZEBPAY_STARTUP_TIMEOUT_MS', 6_000));

  process.stdout.write(`starting dashboard for ${symbol}…\n`);

  // ── 1. Decide LIVE vs DEMO, with a hard cap on how long we wait. ─────────
  const { feed, mode, reason } = await buildFeed({
    client, symbol, forceDemo, probeTimeoutMs,
  });

  if (mode === 'demo') {
    process.stdout.write(
      `${forceDemo ? '·' : '⚠'} ${reason ?? 'live upstream unavailable'}\n` +
        `  Using SYNTHETIC DEMO data. No real prices are shown and none are claimed.\n`,
    );
  } else {
    process.stdout.write(`✓ connected to ${config.baseUrl}\n`);
  }

  // ── 2. Construct (but do not start) the bot and AI stack. ────────────────
  // Construction is synchronous and does no I/O, so the server can be created
  // with real references immediately. Starting them happens after the port is
  // bound.
  let engine = null;
  if (flags.bot === true) {
    const { buildEngine } = await import('./engine-factory.js');
    engine = buildEngine({ client, config, flags, feed, feedMode: mode });
    engine.on('signal', (r) =>
      process.stdout.write(`  [bot] ${r.signal.action} — ${r.signal.reason}\n`),
    );
    engine.on('warmup', (w) =>
      process.stdout.write(`  [bot] warm-up complete — ${w.candles} candles loaded\n`),
    );
    engine.on('error', (e) => process.stdout.write(`  [bot] error: ${e.message}\n`));
  }

  let ai = null;
  if (flags.ai === true) {
    ai = await buildAiStack({ client, config, flags, feed, mode });
  }

  // Mutable so the background clock-skew probe can fill it in later.
  const runtime = { clockSkewMs: null };
  const server = createDashboardServer({ feed, engine, symbol, mode, ai, config, runtime });

  // ── 3. Bind the port. From here the page is reachable. ───────────────────
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0 so the server is reachable from outside the container (proxied previews).
    server.listen(port, '0.0.0.0', resolve);
  });

  const addr = server.address();
  process.stdout.write(`\n  dashboard  http://localhost:${addr.port}\n`);
  process.stdout.write(`  data mode  ${mode.toUpperCase()}${mode === 'demo' ? ' (synthetic)' : ''}\n`);
  process.stdout.write(`  orders     ${engine?.gateway?.mode ?? 'n/a'}\n`);
  process.stdout.write(`  stream     GET /api/stream (SSE)\n\n`);

  // ── 4. Everything slow happens now, off the request path. ────────────────
  void loadBackground({ client, feed, engine, ai, mode });
  void measureSkew(client, runtime);

  const shutdown = () => {
    feed.stop();
    ai?.runner.stop();
    server.close(() => process.exit(0));
    // Force-exit if a keep-alive connection holds the server open.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Start feed polling, candle history, the bot and the AI scanner.
 *
 * None of this is awaited by the caller: the page is already serving, and a
 * failure in any one of them is reported to stdout and into the feed's own
 * `lastError`, which the UI surfaces as a warning.
 */
async function loadBackground({ client, feed, engine, ai, mode }) {
  try {
    await feed.start();
  } catch (err) {
    process.stdout.write(`  ⚠ feed start failed: ${err.message}\n`);
  }

  try {
    await feed.loadCandles('1m', 180);
    process.stdout.write(`  ✓ candle history loaded (${feed.candles.length} candles)\n`);
  } catch (err) {
    process.stdout.write(`  ⚠ candle history not loaded: ${err.message}\n`);
  }

  if (engine) {
    try {
      await engine.start();
      process.stdout.write(`  ✓ bot started (${engine.strategyName}, ${engine.gateway.mode})\n`);
    } catch (err) {
      process.stdout.write(`  ⚠ bot failed to start: ${err.message}\n`);
    }
  }

  if (ai) ai.runner.start();
  if (mode === 'demo') {
    process.stdout.write(
      `  ⚠ demo mode: prices are synthetic. Run 'npm run check:live' from a machine\n` +
        `    that can reach futuresbe.zebpay.com to verify the live API.\n`,
    );
  }
}

/**
 * Measure clock skew in the background.
 *
 * A skewed clock is the most common cause of `400 Invalid signature`, but it is
 * not worth blocking startup for — so it is measured after the port is bound and
 * folded into the Fix Report when it arrives.
 */
async function measureSkew(client, runtime) {
  try {
    runtime.clockSkewMs = await client.measureClockSkew();
    if (Math.abs(runtime.clockSkewMs) > 5_000) {
      process.stdout.write(
        `  ⚠ clock skew is ${Math.round(runtime.clockSkewMs)} ms — signed requests may be rejected.\n`,
      );
    }
  } catch {
    // Unreachable upstream; the feed will have reported it already.
    runtime.clockSkewMs = null;
  }
}

/** Build the AI stack and attach its console reporting. */
async function buildAiStack({ client, config, flags, feed, mode }) {
  const { buildAutonomous } = await import('./ai-factory.js');
  const ai = buildAutonomous({ client, config, flags, feed, feedMode: mode });

  // Autonomous execution is a separate, opt-in step and defaults off.
  const autonomous = flags.autonomous === true;
  if (autonomous) {
    ai.permissions.set('autonomousEntries', true, 'cli');
    ai.permissions.set('autonomousExits', true, 'cli');
  }

  ai.runner.on('cycle', (r) => {
    const top = r.ranked?.[0];
    if (!top) {
      process.stdout.write(`  [ai] cycle ${r.cycle} · nothing scanned (${r.error ?? 'no symbols'})\n`);
      return;
    }
    // `score` is confidence in whatever the model chose — including NO_TRADE.
    // Printing "NO_TRADE (95%)" reads as 95% confidence about a trade that did
    // not happen, so always name what the score belongs to.
    const model = `${top.modelDirection ?? 'NO_TRADE'} @ ${top.score ?? 0}%`;
    const outcome = r.acted
      ? `ACTED ${r.acted.trace.action} ${r.acted.trace.symbol}`
      : top.action === 'NO_TRADE' && top.modelDirection !== 'NO_TRADE'
        ? `vetoed — ${top.reason}`
        : 'no position';
    process.stdout.write(
      `  [ai] cycle ${r.cycle} · ${r.symbols} symbols · ${r.durationMs}ms · ` +
        `${top.symbol} ${top.regime ?? '—'} · model ${model} → ${outcome}\n`,
    );
  });
  ai.runner.on('error', (e) => process.stdout.write(`  [ai] error: ${e.message}\n`));
  ai.killSwitch.on('engage', (e) =>
    process.stdout.write(`  [ai] ⛔ KILL SWITCH ENGAGED: ${e.reason}\n`),
  );
  // Log the resume too. Without it the log reads as "engaged, then traded
  // anyway", which looks exactly like a safety failure even when it is not.
  ai.killSwitch.on('resume', (e) =>
    process.stdout.write(`  [ai] ▶ kill switch resumed: ${e.reason}\n`),
  );
  ai.killSwitch.on('trip', (e) =>
    process.stdout.write(`  [ai] ⛔ breaker tripped: ${e.code} ${e.detail}\n`),
  );

  process.stdout.write(
    `  [ai] autonomous execution ${autonomous ? 'ENABLED' : 'disabled'} · ` +
      `order mode ${ai.gateway.mode} · credentials ${ai.hasCredentials ? 'present' : 'missing'}\n`,
  );
  if (!autonomous) {
    process.stdout.write(`  [ai] evaluating and explaining only; pass --autonomous to let it act.\n`);
  }
  return ai;
}
