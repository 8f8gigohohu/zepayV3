import { buildFeed } from '../server/app.js';
import { buildAutonomous } from './ai-factory.js';

/**
 * `zepay ai` — run the autonomous stack headlessly.
 *
 * Prints one row per symbol with the decision and, crucially, the reason. A
 * screen full of `NO_TRADE` with explanations is the normal, healthy output of
 * this command; a screen full of orders would not be.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 */
export async function runAi({ client, config, flags }) {
  const symbol = flags.symbol ?? 'BTCINR';
  const cycles = Number(flags.cycles ?? 1);
  const pollMs = Number(flags.scanMs ?? 30_000);

  const { feed, mode, reason } = await buildFeed({ client, symbol, forceDemo: flags.demo === true });
  if (mode === 'demo') {
    process.stdout.write(`${flags.demo === true ? '·' : '⚠'} ${reason ?? 'live upstream unavailable'}; using synthetic demo data.\n`);
  }
  await feed.start();

  const ai = buildAutonomous({ client, config, flags, feed, feedMode: mode });
  if (flags.autonomous === true) {
    ai.permissions.set('autonomousEntries', true, 'cli');
    ai.permissions.set('autonomousExits', true, 'cli');
  }

  process.stdout.write(
    `\nzepay ai · ${mode} data · order mode ${ai.gateway.mode} · ` +
      `autonomous execution ${ai.permissions.can('autonomousEntries') ? 'ENABLED' : 'disabled'}\n\n`,
  );

  // A readiness check first, so a run that cannot trade says why immediately
  // instead of producing N identical "no data" rows.
  const account = await ai.fetchAccount();
  const ready = [];
  ready.push(['credentials', ai.hasCredentials ? 'ok' : `missing — ${ai.accountState.lastError}`]);
  ready.push(['equity', account.equity > 0 ? String(account.equity) : `unavailable — ${ai.accountState.lastError}`]);
  ready.push(['feed', mode]);
  ready.push(['kill switch', ai.killSwitch.blocked ? `ENGAGED (${ai.killSwitch.reason})` : 'clear']);
  for (const [k, v] of ready) process.stdout.write(`  ${k.padEnd(12)} ${v}\n`);
  process.stdout.write('\n');

  let done = 0;
  const runOne = async () => {
    const result = await ai.runner.cycle();
    done += 1;
    if (!result.ok) {
      process.stdout.write(`cycle ${done}: FAILED — ${result.error}\n\n`);
      return;
    }
    process.stdout.write(
      `cycle ${done} · ${result.symbols} symbols · ${result.durationMs}ms\n`,
    );
    for (const row of result.ranked) {
      // Show the model's own call alongside the final action, so a veto is
      // visibly a veto rather than looking like indecision.
      const model = row.modelDirection && row.modelDirection !== row.action
        ? `${row.modelDirection} vetoed`
        : row.action;
      process.stdout.write(
        `  ${row.symbol.padEnd(12)} ${String(row.score ?? 0).padStart(5)}%  ` +
          `${(row.regime ?? '—').padEnd(16)} ${model.padEnd(13)} ${row.reason ?? row.why ?? ''}\n`,
      );
    }
    if (result.acted) {
      const t = result.acted.trace;
      process.stdout.write(
        `\n  → ACTED: ${t.action} ${t.symbol} @ ${t.projection?.entryPrice ?? '?'} ` +
          `(mode ${result.acted.execution?.mode ?? 'dry-run'})\n`,
      );
    } else {
      process.stdout.write('\n  no position opened this cycle\n');
    }
    process.stdout.write('\n');
  };

  for (let i = 0; i < cycles; i++) {
    await runOne();
    if (i < cycles - 1) await sleep(pollMs);
  }

  const s = ai.pipeline.status();
  process.stdout.write(
    `totals: ${s.cycles} cycles · ${s.executions} executions · ${s.noTrades} no-trades\n` +
      `safety: kill switch ${s.killSwitch.blocked ? 'ENGAGED' : 'clear'} · ` +
      `autonomous entries ${s.permissions.autonomousEntries ? 'enabled' : 'disabled'} · ` +
      `live trading ${s.permissions.allowLiveTrading ? 'ALLOWED' : 'blocked'}\n`,
  );

  feed.stop();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
