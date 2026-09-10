/**
 * zepayV3 — ZebPay Futures SDK, strategy engine and dashboard.
 *
 * @example Market data
 *   import { ZebpayFuturesClient } from 'zepayv3';
 *   const client = new ZebpayFuturesClient();
 *   const book = await client.getOrderBook('BTC-INR');   // accepts UI or API form
 *
 * @example Authenticated reads
 *   const client = new ZebpayFuturesClient({ apiKey, apiSecret });
 *   const balance = await client.getWalletBalance();
 *
 * @example Dry-run strategy
 *   const gateway = new OrderGateway({ priceSource: () => feed.lastPrice });
 *   const engine = new StrategyEngine({ client, gateway, strategy, symbol: 'BTCINR' });
 *   await engine.start();
 */

export { ZebpayFuturesClient, assertOrderShape } from './client/ZebpayFutures.js';
export { HttpTransport } from './core/http.js';
export {
  ZebpayError,
  ApiError,
  AuthError,
  RateLimitError,
  TransportError,
  ValidationError,
  LiveTradingBlockedError,
  errorClassFor,
} from './core/errors.js';
export {
  hmacSha256Hex,
  encodeQuery,
  signGet,
  signBody,
  signSocketAuth,
  compactBody,
} from './core/sign.js';
export {
  normalizeSymbol,
  splitSymbol,
  toDisplaySymbol,
  assertTimeframe,
  parseKlineRow,
  KLINE_TIMEFRAMES,
  TIMEFRAME_MS,
} from './core/symbols.js';
export { loadEnv, resolveConfig, envFlag, envStr, envInt, envNum } from './core/env.js';
export { PrivateStream } from './ws/PrivateStream.js';
export { OrderGateway } from './strategy/OrderGateway.js';
export { StrategyEngine, dropFormingCandle } from './strategy/engine.js';
export { createEmaCrossStrategy } from './strategy/strategies/emaCross.js';
export { sma, ema, rsi, atr, rollingExtremes, closes } from './strategy/indicators.js';
export { MarketFeed, DemoMarketFeed } from './server/marketFeed.js';
export { createDashboardServer, buildFeed } from './server/app.js';

/* ── AI autonomous stack ───────────────────────────────────────────────────── */

export { extractFeatures, extractBookFeatures, classifyRegime } from './ai/features.js';
export {
  createDecisionEngine,
  DEFAULT_WEIGHTS,
  DEFAULT_GEOMETRY,
  REGIME_STRATEGY,
} from './ai/engine.js';
export { projectTrade, sizeByRisk, DEFAULT_COST_CONFIG } from './costs/engine.js';
export { RiskEngine, DEFAULT_RISK_LIMITS } from './risk/engine.js';
export { KillSwitch } from './risk/killswitch.js';
export { PermissionEngine, DEFAULT_PERMISSIONS } from './permissions/engine.js';
export { AuditLog, redact } from './audit/log.js';
export {
  discoverUniverse,
  fetchSymbolData,
  rankByTicker,
  DEFAULT_UNIVERSE_FILTER,
} from './scanner/scanner.js';
export { AutonomousPipeline } from './autonomous/pipeline.js';
export { AutonomousRunner } from './autonomous/runner.js';
export {
  buildAutonomous,
  readEquity,
  normalisePositions,
  simulatedPositions,
} from './commands/ai-factory.js';
