import { OrderGateway } from '../strategy/OrderGateway.js';
import { StrategyEngine } from '../strategy/engine.js';
import { createEmaCrossStrategy } from '../strategy/strategies/emaCross.js';

/**
 * Construct a strategy engine wired to an existing market feed.
 *
 * Shared by the `run` and `dashboard --bot` commands so both get identical
 * safety behaviour: live trading needs `ZEBPAY_ALLOW_LIVE=true` *and* `--live`,
 * and is additionally suppressed whenever the feed is not live.
 *
 * @param {object} args
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} args.client
 * @param {object} args.config
 * @param {object} args.flags
 * @param {object} args.feed      live or demo feed, supplies the fill price
 * @param {'live'|'demo'} args.feedMode
 * @param {(fill:object)=>void} [args.onFill]
 * @returns {StrategyEngine}
 */
export function buildEngine({ client, config, flags, feed, feedMode, onFill }) {
  const symbol = flags.symbol ?? 'BTCINR';
  const timeframe = flags.tf ?? '1m';
  const amount = Number(flags.amount ?? 0.001);
  const pollMs = Number(flags.pollMs ?? 15_000);
  const liveFlag = flags.live === true;
  const takerFeeRate = Number(flags.takerFee) || 0.001; // 0.1%, the documented BTCINR taker fee

  // Synthetic prices cannot back a real order. Suppress live mode entirely when
  // the feed is not live, regardless of what the operator asked for.
  const allowLive = config.allowLive && feedMode === 'live';

  const gateway = new OrderGateway({
    client,
    allowLive,
    liveFlag,
    priceSource: () => feed.lastPrice,
    takerFeeRate,
    onFill,
  });

  const strategy = createEmaCrossStrategy({
    fastPeriod: Number(flags.fast ?? 9),
    slowPeriod: Number(flags.slow ?? 21),
    amount,
    allowShort: flags.short === true,
  });

  return new StrategyEngine({
    client,
    gateway,
    strategy,
    symbol,
    timeframe,
    pollMs,
    orderAmount: amount,
    // With synthetic data the client cannot fetch history, so drive the engine
    // from the feed's own maintained candle series.
    candlesSource: feedMode === 'demo' ? () => feed.loadCandles(timeframe, 200) : undefined,
  });
}
