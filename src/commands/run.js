import { buildFeed } from '../server/app.js';
import { buildEngine } from './engine-factory.js';

/**
 * Run the strategy engine.
 *
 * Mode selection is intentionally explicit and loud. Live trading needs BOTH
 * `ZEBPAY_ALLOW_LIVE=true` in the environment AND `--live` on the command line;
 * with either missing the gateway stays in dry-run and cannot transmit an order.
 *
 * The market feed doubles as the dry-run price source, so simulated fills price
 * against real quotes rather than the signal price. When the upstream is
 * unreachable the feed falls back to synthetic data and the run is labelled
 * accordingly — and live trading is suppressed regardless.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 */
export async function runStrategy({ client, config, flags }) {
  const symbol = flags.symbol ?? 'BTCINR';
  const amount = Number(flags.amount ?? 0.001);

  const { feed, mode: feedMode, reason } = await buildFeed({
    client,
    symbol,
    forceDemo: flags.demo === true,
    intervalMs: 2_000,
  });

  if (config.allowLive && feedMode !== 'live') {
    console.log(
      '⚠ ZEBPAY_ALLOW_LIVE is set but the market feed is not live, so live trading is disabled.\n',
    );
  }

  let takerFeeRate = 0;
  try {
    const fee = await client.getTradeFee(symbol);
    takerFeeRate = (Number(fee?.[0]?.takerFee) || 0) / 100; // API returns percent
  } catch {
    takerFeeRate = 0.001; // documented BTCINR taker fee is 0.1%
  }

  const engine = buildEngine({
    client,
    config,
    flags: { ...flags, takerFee: takerFeeRate },
    feed,
    feedMode,
    onFill: (f) => console.log(fillLine(f)),
  });

  engine.on('start', (e) =>
    console.log(
      `\n  strategy   ${engine.strategy.name}\n` +
        `  symbol     ${e.symbol} · ${e.timeframe}\n` +
        `  data       ${feedMode}${feedMode === 'demo' ? ` (synthetic — ${reason ?? 'upstream unreachable'})` : ''}\n` +
        `  mode       ${e.mode.toUpperCase()}${e.mode === 'live' ? '  ← real orders' : '  (no orders will be transmitted)'}\n` +
        `  amount     ${amount} base · taker fee ${(takerFeeRate * 100).toFixed(3)}%\n`,
    ),
  );
  engine.on('warmup', (e) => console.log(`  warmup     ${e.candles} candles loaded`));
  engine.on('hold', () => {
    const s = engine.status();
    process.stdout.write(
      `\r  tick #${s.ticks}  ${new Date().toLocaleTimeString()}  ${s.symbol} ${s.position.qty >= 0 ? 'long' : 'short'} ${Math.abs(s.position.qty)}  pnl ${s.position.realizedPnl.toFixed(0)}   `,
    );
  });
  engine.on('signal', (rec) => {
    console.log(`\n  SIGNAL ${rec.signal.action} — ${rec.signal.reason}`);
    if (rec.error) console.log(`  execution failed: ${rec.error.message}`);
  });
  engine.on('error', (err) => console.error(`  error: ${err.message}`));

  await feed.start();
  await engine.start();

  const shutdown = () => {
    console.log('\n  stopping…');
    engine.stop();
    feed.stop();
    const s = engine.status();
    console.log(
      `  ticks ${s.ticks} · errors ${s.errors} · fills ${s.position.fills} · ` +
        `realized ${s.position.realizedPnl.toFixed(2)} (net of ${s.position.fees.toFixed(2)} fees)`,
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function fillLine(f) {
  if (f.action === 'cancel') return `  [dry-run] cancel ${f.clientOrderId}`;
  return (
    `  [${f.mode}] ${f.side} ${f.amount} ${f.symbol} @ ${Math.round(f.price ?? 0)} ` +
    `notional ${Math.round(f.notional ?? 0)} fee ${(f.fee ?? 0).toFixed(2)} (${f.clientOrderId})`
  );
}
