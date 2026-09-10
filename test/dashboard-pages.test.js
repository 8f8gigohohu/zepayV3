import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createDashboardServer, buildFeed } from '../src/server/app.js';
import { DemoMarketFeed, MarketFeed } from '../src/server/marketFeed.js';
import { describeSetup, maskSecret, maskSecretValue, ENV_VARS } from '../src/server/setup.js';
import { buildFixReport, formatFixReport } from '../src/server/report.js';
import { ZebpayFuturesClient } from '../src/client/ZebpayFutures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Deliberately not shaped like any real provider's credential. An earlier
// version of this fixture copied a well-known payment provider's key format, and
// GitHub push protection correctly rejected the push. A test fixture should
// never resemble a real secret — the masking logic does not care what the
// characters look like, only how long the string is.
const FAKE_SECRET = 'zp-test-secret-DO-NOT-USE-0123456789';
const FAKE_KEY = 'zp-test-key-DO-NOT-USE-0123456789';

/** Boot a dashboard whose config pretends to hold real credentials. */
async function boot({ mode = 'demo', config = {}, engine = null } = {}) {
  const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
  const server = createDashboardServer({
    feed,
    engine,
    symbol: 'BTCINR',
    mode,
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, baseUrl: 'https://futuresbe.zebpay.com', ...config },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    feed,
    close: async () => {
      feed.stop();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ── Pages and navigation ────────────────────────────────────────────────── */

test('the dashboard serves one page per function with navigation between them', async () => {
  const ctx = await boot();
  try {
    const html = await (await fetch(ctx.base + '/')).text();

    // Every required page exists as its own section.
    for (const page of ['overview', 'market', 'bot', 'ai', 'setup', 'report']) {
      assert.match(html, new RegExp(`id="page-${page}"`), `missing page: ${page}`);
    }
    // And every page is reachable from the nav.
    for (const route of ['overview', 'market', 'bot', 'ai', 'setup', 'report']) {
      assert.match(html, new RegExp(`href="#/${route}"`), `missing nav link: ${route}`);
    }
    assert.match(html, /<nav id="nav"/, 'navigation bar is missing');
  } finally {
    await ctx.close();
  }
});

test('the live market page exposes every required element', async () => {
  const ctx = await boot();
  try {
    const html = await (await fetch(ctx.base + '/')).text();
    for (const id of ['chart', 'book', 'trades', 'stats', 'connStats', 'lastPrice', 'change', 'modeBadge', 'linkBadge']) {
      assert.match(html, new RegExp(`id="${id}"`), `live market page is missing #${id}`);
    }
  } finally {
    await ctx.close();
  }
});

/* ── LIVE / DEMO labelling ───────────────────────────────────────────────── */

test('the config endpoint states the data mode unambiguously', async () => {
  const ctx = await boot({ mode: 'demo' });
  try {
    const cfg = await (await fetch(ctx.base + '/api/config')).json();
    assert.equal(cfg.mode, 'demo');
    assert.equal(cfg.demo, true);
    assert.equal(cfg.upstream, 'synthetic', 'demo must not name a real upstream');
    assert.equal(cfg.realOrdersAllowed, false);
  } finally {
    await ctx.close();
  }
});

test('demo mode never claims to serve real prices', async () => {
  const ctx = await boot({ mode: 'demo' });
  try {
    const snap = await (await fetch(ctx.base + '/api/snapshot')).json();
    assert.equal(snap.demo, true, 'the snapshot itself is flagged as synthetic');
    const html = await (await fetch(ctx.base + '/app.js')).text();
    assert.match(html, /synthetic/, 'the UI copy must describe demo data as synthetic');
    assert.match(html, /not real prices|must not be used for trading/i);
  } finally {
    await ctx.close();
  }
});

/* ── Bot status page ─────────────────────────────────────────────────────── */

test('the bot endpoint reports idle state with a reason', async () => {
  const ctx = await boot();
  try {
    const b = await (await fetch(ctx.base + '/api/bot')).json();
    assert.equal(b.enabled, false, 'no --bot means no engine');
    assert.equal(b.running, false);
    assert.equal(b.mode, 'dry-run');
    assert.equal(b.fillCount, 0);
    assert.equal(b.errors, 0);
    // A plain "idle" is not actionable; the reason must be present.
    assert.equal(b.idleReason, null, 'with no engine there is no idle reason to give');
  } finally {
    await ctx.close();
  }
});

test('a stopped engine explains why it is idle', async () => {
  const { StrategyEngine } = await import('../src/strategy/engine.js');
  const { OrderGateway } = await import('../src/strategy/OrderGateway.js');
  const engine = new StrategyEngine({
    client: {},
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { name: 'test', onCandles: () => null },
    symbol: 'BTCINR',
  });

  assert.match(engine.idleReason(), /not started/);
  engine.running = true;
  assert.match(engine.idleReason(), /warming up|loading candle history/, 'warm-up is a distinct state');
  engine.warmupDone = true;
  assert.match(engine.idleReason(), /no candle history/);
  engine.candles = [{ t: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  assert.match(engine.idleReason(), /waiting for the first completed candle/);
  engine.lastSignal = { action: 'HOLD', reason: 'no crossover yet' };
  assert.match(engine.idleReason(), /no crossover yet/);

  const st = engine.status();
  assert.equal(st.strategy, 'test', 'the strategy name is surfaced');
  assert.deepEqual(st.warmup, { done: true, candles: 1, error: null });
});

test('a warm-up failure is recorded and surfaced, not swallowed', async () => {
  const { StrategyEngine } = await import('../src/strategy/engine.js');
  const { OrderGateway } = await import('../src/strategy/OrderGateway.js');
  const engine = new StrategyEngine({
    client: { getKlinesHistory: async () => { throw new Error('klines down'); } },
    gateway: new OrderGateway({ priceSource: () => 1 }),
    strategy: { name: 'test', onCandles: () => null },
    symbol: 'BTCINR',
  });
  await engine.start();

  const st = engine.status();
  assert.equal(st.warmup.done, false);
  assert.match(st.warmup.error, /klines down/);
  assert.equal(st.errors, 1);
  // Checked while still running: a stopped engine reports "not started", which
  // is a different (and correct) answer.
  assert.match(engine.idleReason(), /warming up failed: klines down/);

  engine.stop();
  assert.match(engine.idleReason(), /not started/);
});

/* ── Setup page and secret handling ──────────────────────────────────────── */

test('the setup page never contains a secret value', async () => {
  const ctx = await boot();
  try {
    const raw = await (await fetch(ctx.base + '/api/setup')).text();
    assert.doesNotMatch(raw, new RegExp(FAKE_SECRET), 'the API secret leaked into the response');
    assert.doesNotMatch(raw, new RegExp(FAKE_KEY), 'the API key leaked into the response');
    // But it does confirm the key is loaded, via a fingerprint.
    const s = JSON.parse(raw);
    assert.equal(s.credentials.present, true);
    assert.ok(s.credentials.keyFingerprint.includes('…'), 'the fingerprint is masked');
    assert.doesNotMatch(s.credentials.keyFingerprint, /SUPERsecret/);
  } finally {
    await ctx.close();
  }
});

test('describeSetup reports presence and purpose without exposing secrets', () => {
  const s = describeSetup({
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET },
    feedMode: 'demo',
    env: {
      ZEBPAY_API_KEY: FAKE_KEY,
      ZEBPAY_API_SECRET: FAKE_SECRET,
      ZEBPAY_ALLOW_LIVE: 'false',
      PORT: '4173',
    },
  });

  const byKey = Object.fromEntries(s.variables.map((v) => [v.key, v]));
  assert.equal(byKey.ZEBPAY_API_KEY.set, true);
  assert.equal(byKey.ZEBPAY_API_KEY.value, null, 'a secret must never carry a raw value');
  assert.equal(byKey.ZEBPAY_API_KEY.masked, maskSecret(FAKE_KEY));
  assert.equal(byKey.PORT.value, '4173', 'non-secret values are shown so they can be confirmed');
  assert.equal(byKey.ZEBPAY_SUBACCOUNT_ID.set, false);
  assert.deepEqual(s.missingRequired, [], 'both required vars are set here');

  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /SUPERsecret/);
});

test('missing required variables are called out', () => {
  const s = describeSetup({ config: {}, feedMode: 'demo', env: {} });
  assert.deepEqual(s.missingRequired.sort(), ['ZEBPAY_API_KEY', 'ZEBPAY_API_SECRET']);
});

test('a short key is masked entirely rather than half-revealed', () => {
  assert.equal(maskSecret('abc123'), '••••••');
  assert.equal(maskSecret(''), '');
  assert.ok(maskSecret(FAKE_KEY).includes('…'));
  // Four characters at each end, nothing more.
  assert.equal(maskSecret(FAKE_KEY).length, 9);
});

test('the secret is masked more aggressively than the key', () => {
  // A key is an identifier, so its tail is harmless to show. The secret is the
  // credential itself, so only a prefix is ever revealed.
  const masked = maskSecretValue(FAKE_SECRET);
  assert.ok(masked.startsWith(FAKE_SECRET.slice(0, 4)), 'a prefix is shown for recognition');
  assert.ok(!masked.includes(FAKE_SECRET.slice(-4)), 'the tail of the secret must never appear');
  assert.ok(!masked.includes(FAKE_SECRET.slice(8)), 'nor most of its body');
  assert.match(masked, /hidden/);
  assert.equal(maskSecretValue(''), '');
  assert.equal(maskSecretValue('short'), '•••••');
});

test('the setup payload masks the secret differently from the key', () => {
  const s = describeSetup({
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET },
    feedMode: 'demo',
    env: { ZEBPAY_API_KEY: FAKE_KEY, ZEBPAY_API_SECRET: FAKE_SECRET },
  });
  const byKey = Object.fromEntries(s.variables.map((v) => [v.key, v]));
  assert.equal(byKey.ZEBPAY_API_KEY.masked, maskSecret(FAKE_KEY));
  assert.equal(byKey.ZEBPAY_API_SECRET.masked, maskSecretValue(FAKE_SECRET));
  assert.ok(
    !byKey.ZEBPAY_API_SECRET.masked.includes(FAKE_SECRET.slice(-4)),
    'the secret tail must not be in the payload',
  );
});

test('every documented environment variable is described on the setup page', () => {
  const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8');
  for (const v of ENV_VARS) {
    assert.match(example, new RegExp(`^${v.key}=`, 'm'), `.env.example is missing ${v.key}`);
  }
});

test('.env is gitignored and .env.example is not', () => {
  const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m, '.env must be gitignored');
  assert.match(ignore, /^!\.env\.example$/m, 'the example must be explicitly allowed');
});

/* ── Fix Report ──────────────────────────────────────────────────────────── */

test('the fix report describes real state, not a generic checklist', async () => {
  const ctx = await boot({ mode: 'demo' });
  try {
    const r = await (await fetch(ctx.base + '/api/report')).json();
    const ids = r.entries.map((e) => e.id);

    assert.ok(ids.includes('DEMO_DATA'), 'demo mode must be reported');
    assert.ok(!ids.includes('LIVE_DATA'), 'and must not also claim live data');
    assert.ok(ids.includes('LIVE_TRADING'), 'trading safety is always reported');
    assert.ok(!ids.includes('NO_CREDENTIALS'), 'credentials are present in this test');

    for (const e of r.entries) {
      for (const field of ['id', 'problem', 'rootCause', 'fix', 'expected', 'status', 'severity']) {
        assert.ok(field in e, `entry ${e.id} is missing ${field}`);
      }
      assert.ok(['ok', 'issue'].includes(e.status));
    }
    assert.ok(typeof r.text === 'string' && r.text.length > 100, 'a copyable text form is provided');
  } finally {
    await ctx.close();
  }
});

test('the fix report switches to live entries when the feed is live', () => {
  const entries = buildFixReport({
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, allowLive: false },
    feedMode: 'live',
    bot: { running: true, warmup: { done: true, candles: 100 }, errors: 0, mode: 'dry-run', strategy: 'ema-cross(9,21)', fills: 2 },
  });
  const ids = entries.map((e) => e.id);
  assert.ok(ids.includes('LIVE_DATA'));
  assert.ok(!ids.includes('DEMO_DATA'));
  assert.ok(ids.includes('BOT_OK'));
  assert.ok(ids.includes('CREDENTIALS'));
});

test('the fix report escalates on real faults', () => {
  const entries = buildFixReport({
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, allowLive: true },
    feedMode: 'live',
    feedFailures: 3,
    feedError: 'HTTP 429',
    clockSkewMs: 12_000,
    ai: { enabled: true, killSwitchBlocked: true, killSwitchReason: 'drawdown breaker' },
    liveChecksPassed: false,
  });
  const ids = entries.map((e) => e.id);
  for (const expected of ['UPSTREAM_FAILURES', 'CLOCK_SKEW', 'KILL_SWITCH', 'LIVE_CHECK_FAILED']) {
    assert.ok(ids.includes(expected), `missing entry ${expected}`);
  }
  const live = entries.find((e) => e.id === 'LIVE_TRADING');
  assert.equal(live.status, 'issue', 'live trading enabled must be flagged, not reported as ok');
});

test('the report text is plain text with all four fields per entry', () => {
  const entries = buildFixReport({ config: {}, feedMode: 'demo' });
  const text = formatFixReport(entries, { feedMode: 'demo', orderMode: 'dry-run' });

  assert.match(text, /ZEPAY DASHBOARD — FIX REPORT/);
  assert.match(text, /data mode: demo/);
  assert.match(text, /order mode: dry-run/);
  for (const label of ['Problem:', 'Root cause:', 'Fix:', 'Expected:']) {
    assert.match(text, new RegExp(label.replace('(', '\\(')), `missing ${label}`);
  }
  // Plain text, not markup — it is meant to be pasted into an issue or chat.
  assert.doesNotMatch(text, /<\/?[a-z]+>/i, 'the report must not contain HTML');
});

test('the report redacts a secret even if a caller passes one in', () => {
  const text = formatFixReport(
    buildFixReport({
      config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET },
      feedMode: 'demo',
    }),
    { feedMode: 'demo' },
  );
  assert.doesNotMatch(text, /SUPERsecret/, 'the secret must not reach the clipboard');
});

/* ── No browser order endpoint ───────────────────────────────────────────── */

test('there is no HTTP route that can place an order', async () => {
  const ctx = await boot();
  try {
    const attempts = [
      ['POST', '/api/order'],
      ['POST', '/api/orders'],
      ['POST', '/api/trade/order'],
      ['POST', '/api/ai/order'],
      ['POST', '/api/ai/trade'],
      ['POST', '/api/buy'],
      ['POST', '/api/sell'],
    ];
    for (const [method, path] of attempts) {
      const res = await fetch(ctx.base + path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.ok(
        res.status === 404 || res.status === 405,
        `${method} ${path} returned ${res.status} — no order route may exist`,
      );
    }
  } finally {
    await ctx.close();
  }
});

test('real orders stay disabled unless explicitly enabled', async () => {
  const ctx = await boot({ config: { allowLive: false } });
  try {
    const cfg = await (await fetch(ctx.base + '/api/config')).json();
    assert.equal(cfg.realOrdersAllowed, false);
    assert.equal(cfg.orderMode, 'dry-run');
  } finally {
    await ctx.close();
  }
});

/* ── Non-blocking startup ────────────────────────────────────────────────── */

test('a hung upstream cannot block feed selection past the probe timeout', async () => {
  // A client whose request never resolves simulates a hung TLS handshake.
  const hanging = new ZebpayFuturesClient({
    transport: { async request() { return new Promise(() => {}); } },
  });
  const started = Date.now();
  const { feed, mode, reason } = await buildFeed({
    client: hanging, symbol: 'BTCINR', probeTimeoutMs: 150,
  });
  const elapsed = Date.now() - started;

  assert.equal(mode, 'demo', 'a hung probe must fall back to demo, not wait forever');
  assert.ok(elapsed < 1_500, `the probe took ${elapsed}ms; it should be bounded`);
  assert.match(reason, /did not respond within/, 'the reason says why, rather than "unknown"');
  assert.ok(feed instanceof DemoMarketFeed);
  feed.stop();
});

test('the page is served before any market data arrives', async () => {
  // A feed whose upstream fails on the first attempt: no snapshot, no candles.
  const feed = new MarketFeed({
    client: {
      getTicker24Hr: async () => { throw new Error('not ready'); },
      getOrderBook: async () => { throw new Error('not ready'); },
      getAggTrades: async () => [],
    },
    symbol: 'BTCINR',
  });
  // The background loader has already tried once and failed, which is exactly
  // the state the dashboard is in while it keeps retrying.
  assert.equal(await feed.refresh(), false);

  const server = createDashboardServer({ feed, symbol: 'BTCINR', mode: 'live' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The HTML shell renders with no market data present.
    const html = await fetch(base + '/');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /id="page-overview"/);

    // And the API degrades rather than erroring.
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.equal(snap.lastPrice, null);
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.match(cfg.feedError, /not ready/);
    assert.equal(cfg.feedFailures, 1, 'the failure is counted so the UI can warn');
  } finally {
    feed.stop();
    await new Promise((r) => server.close(r));
  }
});
