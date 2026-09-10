import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as pkg from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `src/index.js` is what `package.json` points `main` and `exports` at, so it is
 * the public surface of the package. Nothing verifies that automatically — a new
 * module added to `src/` is invisible to consumers until someone remembers to
 * re-export it, and nothing fails when they do not.
 */

test('every export named in index.js actually resolves', () => {
  for (const [name, value] of Object.entries(pkg)) {
    assert.notEqual(value, undefined, `${name} is exported as undefined`);
  }
});

test('the package exports the core SDK', () => {
  for (const name of [
    'ZebpayFuturesClient', 'assertOrderShape', 'HttpTransport',
    'ZebpayError', 'ApiError', 'AuthError', 'RateLimitError', 'TransportError',
    'ValidationError', 'LiveTradingBlockedError', 'errorClassFor',
    'hmacSha256Hex', 'encodeQuery', 'signGet', 'signBody', 'signSocketAuth', 'compactBody',
    'normalizeSymbol', 'splitSymbol', 'toDisplaySymbol', 'assertTimeframe', 'parseKlineRow',
    'KLINE_TIMEFRAMES', 'TIMEFRAME_MS',
    'loadEnv', 'resolveConfig', 'envFlag', 'envStr', 'envInt', 'envNum',
    'PrivateStream', 'OrderGateway', 'StrategyEngine', 'dropFormingCandle',
    'createEmaCrossStrategy',
    'sma', 'ema', 'rsi', 'atr', 'rollingExtremes', 'closes',
    'MarketFeed', 'DemoMarketFeed', 'createDashboardServer', 'buildFeed',
    'describeSetup', 'maskSecret', 'maskSecretValue', 'ENV_VARS',
    'buildFixReport', 'formatFixReport',
  ]) {
    assert.ok(name in pkg, `missing export: ${name}`);
  }
});

test('the package exports the AI autonomous stack', () => {
  for (const name of [
    'extractFeatures', 'extractBookFeatures', 'classifyRegime',
    'createDecisionEngine', 'DEFAULT_WEIGHTS', 'DEFAULT_GEOMETRY', 'REGIME_STRATEGY',
    'projectTrade', 'sizeByRisk', 'DEFAULT_COST_CONFIG',
    'RiskEngine', 'DEFAULT_RISK_LIMITS',
    'KillSwitch', 'PermissionEngine', 'DEFAULT_PERMISSIONS',
    'AuditLog', 'redact',
    'discoverUniverse', 'fetchSymbolData', 'rankByTicker', 'DEFAULT_UNIVERSE_FILTER',
    'AutonomousPipeline', 'AutonomousRunner',
    'buildAutonomous', 'readEquity', 'normalisePositions', 'simulatedPositions',
  ]) {
    assert.ok(name in pkg, `missing export: ${name}`);
  }
});

test('package.json main and exports point at a file that loads', () => {
  const manifest = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8'));
  // `main` is written "src/index.js" and `exports` "./src/index.js". Both
  // resolve identically, so compare after stripping a leading "./" rather than
  // demanding the strings match verbatim.
  const norm = (p) => String(p).replace(/^\.\//, '');
  assert.equal(norm(manifest.main), 'src/index.js');
  assert.equal(norm(manifest.exports['.']), norm(manifest.main), 'exports and main must agree');
  // Reaching this line at all proves the file loaded; the import above is the
  // same specifier a consumer would resolve.
  assert.ok(Object.keys(pkg).length > 60, 'the entry point should export the whole stack');
});

test('the declared bin exists and is executable entry code', () => {
  const manifest = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8'));
  const bin = manifest.bin.zepay;
  const src = readFileSync(resolve(HERE, '..', bin), 'utf8');
  assert.match(src, /^#!/, 'the bin must start with a shebang');
  assert.match(src, /case 'ai':/, 'the ai command is wired');
  assert.match(src, /case 'doctor':/, 'the doctor command is wired');
});
