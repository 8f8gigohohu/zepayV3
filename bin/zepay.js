#!/usr/bin/env node
import { loadEnv, resolveConfig } from '../src/core/env.js';
import { ZebpayFuturesClient } from '../src/client/ZebpayFutures.js';
import { ZebpayError } from '../src/core/errors.js';
import { toDisplaySymbol } from '../src/core/symbols.js';

loadEnv();

const HELP = `zepay — ZebPay Futures CLI

Usage: zepay <command> [options]

Market data (no credentials needed)
  time                      server time + local clock skew
  status                    API system status
  ticker [symbol]           24h ticker            (default BTC-INR)
  book   [symbol]           order book, top 5
  trades [symbol]           recent aggregate trades
  klines [symbol]           candles   --tf=1m --limit=20
  markets                   all symbols with precision and leverage caps
  fees   [symbol]           maker/taker fees

Private (needs ZEBPAY_API_KEY / ZEBPAY_API_SECRET)
  balance                   wallet balance
  positions                 open positions
  orders                    open orders

Runners
  dashboard                 live BTC-INR dashboard  --port=4173 --symbol=BTCINR [--bot] [--demo]
  run                       strategy engine         --tf=1m --amount=0.001 [--demo] [--live]

Flags
  --symbol=BTC-INR          pair, dash or concatenated form
  --tf=1m                   kline timeframe
  --limit=20                result count
  --port=4173               dashboard port
  --amount=0.001            order size in base asset for the strategy
  --fast=9 --slow=21        EMA periods for the reference strategy
  --short                   allow the strategy to open short positions
  --bot                     run the strategy engine alongside the dashboard
  --demo                    force synthetic data (also disables live trading)
  --live                    allow real orders (also needs ZEBPAY_ALLOW_LIVE=true)
  --help                    this text
`;

function parseFlags(argv) {
  const flags = { _: [] };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else flags._.push(arg);
  }
  return flags;
}

const num = (v, d) =>
  Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: d }) : '—';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0];
  const symbol = flags.symbol ?? 'BTC-INR';

  if (!cmd || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = resolveConfig();
  const client = new ZebpayFuturesClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    subaccountId: config.subaccountId,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  switch (cmd) {
    case 'time': {
      const skew = await client.measureClockSkew();
      const t = await client.getServerTime();
      console.log(`server time  ${new Date(t.timestamp).toISOString()} (${t.timestamp})`);
      console.log(`clock skew   ${skew >= 0 ? '+' : ''}${Math.round(skew)} ms (server - local)`);
      console.log(Math.abs(skew) > 5000
        ? '⚠ skew is large; signed requests may be rejected. Fix your system clock.'
        : '✓ skew is within a normal range');
      break;
    }

    case 'status': {
      const s = await client.getSystemStatus();
      console.log(`systemStatus: ${s.systemStatus}`);
      break;
    }

    case 'ticker': {
      const t = await client.getTicker24Hr(symbol);
      const pct = Number(t.percentage ?? 0);
      console.log(`${toDisplaySymbol(t.symbol)}  last ${num(t.last, 0)}`);
      console.log(`  24h   ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  (${num(t.change, 0)})`);
      console.log(`  high  ${num(t.high, 0)}   low ${num(t.low, 0)}`);
      console.log(`  bid   ${num(t.bid, 0)}   ask ${num(t.ask, 0)}`);
      console.log(`  vol   ${num(t.baseVolume, 3)} base`);
      break;
    }

    case 'book': {
      const b = await client.getOrderBook(symbol);
      console.log(`${toDisplaySymbol(b.symbol)} order book`);
      for (const [p, q] of (b.asks ?? []).slice(0, 5).reverse()) {
        console.log(`  ask  ${num(p, 0).padStart(12)}  ${num(q, 4)}`);
      }
      const spread = (b.asks?.[0]?.[0] ?? 0) - (b.bids?.[0]?.[0] ?? 0);
      console.log(`  ─── spread ${num(spread, 0)} ───`);
      for (const [p, q] of (b.bids ?? []).slice(0, 5)) {
        console.log(`  bid  ${num(p, 0).padStart(12)}  ${num(q, 4)}`);
      }
      break;
    }

    case 'trades': {
      const trades = await client.getAggTrades(symbol);
      const rows = (trades ?? []).slice(-Number(flags.limit ?? 10));
      for (const t of rows) {
        const side = t.isBuyerMarketMaker === false ? 'BUY ' : 'SELL';
        console.log(`  ${side} ${num(t.price, 0).padStart(12)}  ${num(t.quantity, 4)}  ${new Date(t.tradeTime).toISOString()}`);
      }
      break;
    }

    case 'klines': {
      const tf = flags.tf ?? '1m';
      const limit = Number(flags.limit ?? 20);
      const candles = await client.getKlinesHistory({ symbol, timeframe: tf, count: limit });
      console.log(`${toDisplaySymbol(symbol)} · ${tf} · ${candles.length} candles`);
      for (const c of candles.slice(-limit)) {
        const dir = c.close >= c.open ? '▲' : '▼';
        console.log(
          `  ${new Date(c.t).toISOString().slice(0, 16)}  ${dir} o ${num(c.open, 0).padStart(10)} h ${num(c.high, 0).padStart(10)} l ${num(c.low, 0).padStart(10)} c ${num(c.close, 0).padStart(10)} v ${num(c.volume, 3)}`,
        );
      }
      break;
    }

    case 'markets': {
      const m = await client.getMarkets();
      const symbols = m.symbols ?? [];
      console.log(`${symbols.length} symbols`);
      for (const s of symbols.slice(0, Number(flags.limit ?? 25))) {
        console.log(
          `  ${s.symbol.padEnd(14)} ${String(s.status).padEnd(6)} px ${s.pricePrecision} qty ${s.quantityPrecision} lev ${s.minLeverage}-${s.maxLeverage}x  maker ${s.makerFee}% taker ${s.takerFee}%`,
        );
      }
      break;
    }

    case 'fees': {
      if (flags._[1]) {
        const f = await client.getTradeFee(symbol);
        console.log(JSON.stringify(f, null, 2));
      } else {
        const f = await client.getTradeFees();
        for (const row of (f ?? []).slice(0, Number(flags.limit ?? 20))) {
          console.log(`  ${row.symbol.padEnd(14)} maker ${row.makerFee}%  taker ${row.takerFee}%`);
        }
      }
      break;
    }

    case 'balance':
      console.log(JSON.stringify(await client.getWalletBalance(), null, 2));
      break;

    case 'positions':
      console.log(JSON.stringify(await client.getPositions(flags._[1]), null, 2));
      break;

    case 'orders':
      console.log(JSON.stringify(await client.getOpenOrders(flags._[1]), null, 2));
      break;

    case 'dashboard': {
      const { startDashboard } = await import('../src/commands/dashboard.js');
      await startDashboard({ client, config, flags });
      break;
    }

    case 'run': {
      const { runStrategy } = await import('../src/commands/run.js');
      await runStrategy({ client, config, flags });
      break;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof ZebpayError) {
    console.error(`\n${err.name}: ${err.message}`);
    if (err.status) console.error(`  HTTP ${err.status}${err.path ? ` on ${err.path}` : ''}`);
    if (err instanceof Error && err.name === 'AuthError') {
      console.error('  Check the key scope: fetch:details for reads, futures:trading for writes.');
    }
  } else {
    console.error(`\n${err?.stack ?? err}`);
  }
  process.exitCode = 1;
});
