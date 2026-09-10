import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoMarketFeed, MarketFeed } from '../src/server/marketFeed.js';
import { buildFeed, createDashboardServer } from '../src/server/app.js';
import { ZebpayFuturesClient } from '../src/client/ZebpayFutures.js';
import { TransportError } from '../src/core/errors.js';

/** Recorded BTC-INR shapes captured from the live API, used as fixtures. */
const ORDER_BOOK = {
  symbol: 'BTCINR',
  bids: [[7478615, 4.04], [7478605, 0.142], [7478596, 0.002]],
  asks: [[7478720, 2.814], [7478730, 0.006], [7478739, 0.001]],
  timestamp: 1789016113124,
};

const TICKER = {
  symbol: 'BTCINR',
  last: 7478663,
  open: 7557689,
  high: 7614913,
  low: 7420933,
  change: -79026,
  percentage: -1.0456370988538957,
  vwap: 7521020,
  bid: 7478615,
  ask: 7478720,
  baseVolume: 156951.009,
};

const AGG_TRADES = [
  { aggregateTradeId: 3445031898, symbol: 'BTCINR', price: '7479761', quantity: '0.041', tradeTime: 1789016126209, isBuyerMarketMaker: true },
  { aggregateTradeId: 3445031899, symbol: 'BTCINR', price: '7479751', quantity: '0.001', tradeTime: 1789016126211, isBuyerMarketMaker: false },
];

const KLINES = [[1612345678000, '5500000', '5600000', '5400000', '5550000', '10.5', 1612345738000]];

function liveClientStub() {
  return new ZebpayFuturesClient({
    transport: {
      async request({ path }) {
        if (path.endsWith('/orderBook')) return ORDER_BOOK;
        if (path.endsWith('/ticker24Hr')) return TICKER;
        if (path.endsWith('/aggTrade')) return AGG_TRADES;
        if (path.endsWith('/klines')) return KLINES;
        throw new TransportError(`unexpected ${path}`);
      },
    },
  });
}

/* ── MarketFeed ──────────────────────────────────────────────────────────── */

test('MarketFeed.refresh loads ticker, book and trades in one cycle', async () => {
  const feed = new MarketFeed({ client: liveClientStub(), symbol: 'BTC-INR' });
  const ok = await feed.refresh();

  assert.equal(ok, true);
  assert.equal(feed.symbol, 'BTCINR', 'symbol is normalized');
  assert.equal(feed.lastPrice, TICKER.last);
  assert.equal(feed.orderBook.bids.length, 3);
  assert.equal(feed.trades.length, 2);
  assert.equal(feed.lastError, null);
  assert.equal(feed.polls, 1);
});

test('MarketFeed.refresh records the failure and returns false', async () => {
  const client = new ZebpayFuturesClient({
    transport: {
      async request() {
        throw new TransportError('upstream unreachable');
      },
    },
  });
  const feed = new MarketFeed({ client, symbol: 'BTCINR' });
  const errors = [];
  feed.on('error', (e) => errors.push(e.message));

  assert.equal(await feed.refresh(), false);
  assert.equal(feed.failures, 1);
  assert.match(feed.lastError, /upstream unreachable/);
  assert.equal(errors.length, 1);
});

test('MarketFeed.snapshot derives spread and spreadPct from the top of book', async () => {
  const feed = new MarketFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  await feed.refresh();
  const snap = feed.snapshot();

  assert.equal(snap.spread, 7478720 - 7478615);
  assert.ok(snap.spreadPct > 0 && snap.spreadPct < 0.01, `implausible spread ${snap.spreadPct}%`);
  assert.equal(snap.symbol, 'BTCINR');
  assert.equal(snap.lastError, null);
});

test('MarketFeed.snapshot emits an update event on refresh', async () => {
  const feed = new MarketFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  const seen = [];
  feed.on('update', (s) => seen.push(s.symbol));
  await feed.refresh();
  assert.deepEqual(seen, ['BTCINR']);
});

test('MarketFeed.loadCandles returns parsed candles', async () => {
  const feed = new MarketFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  const candles = await feed.loadCandles('1m', 10);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].close, 5550000);
});

test('MarketFeed.snapshot limits depth per side', async () => {
  const feed = new MarketFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  await feed.refresh();
  assert.equal(feed.snapshot(1).bids.length, 1);
  assert.equal(feed.snapshot(99).bids.length, 3, 'never invents levels');
});

/* ── DemoMarketFeed ──────────────────────────────────────────────────────── */

test('DemoMarketFeed produces a labelled snapshot with a full book', async () => {
  const feed = new DemoMarketFeed({ symbol: 'BTCINR', random: () => 0.5, now: () => 1000 });
  await feed.refresh();
  const snap = feed.snapshot();

  assert.equal(snap.demo, true, 'demo data must be unmistakably labelled');
  assert.ok(snap.lastPrice > 0);
  assert.equal(snap.bids.length, 20);
  assert.equal(snap.asks.length, 20);
  assert.ok(snap.asks[0][0] > snap.bids[0][0], 'asks must sit above bids');
  assert.equal(snap.symbol, 'BTCINR');
});

test('DemoMarketFeed is deterministic given a fixed random source', async () => {
  const mk = () => {
    let seed = 42;
    return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  };
  const a = new DemoMarketFeed({ random: mk(), now: () => 1000 });
  const b = new DemoMarketFeed({ random: mk(), now: () => 1000 });
  await a.refresh();
  await b.refresh();
  assert.equal(a.snapshot().lastPrice, b.snapshot().lastPrice);
});

test('DemoMarketFeed accumulates trades over successive refreshes', async () => {
  const feed = new DemoMarketFeed({ now: () => 1000 });
  await feed.refresh();
  await feed.refresh();
  await feed.refresh();
  assert.equal(feed.polls, 3);
  assert.ok(feed.snapshot().trades.length >= 3);
});

/* ── buildFeed fallback ──────────────────────────────────────────────────── */

test('buildFeed prefers live data when the upstream responds', async () => {
  const { feed, mode } = await buildFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  assert.equal(mode, 'live');
  assert.ok(feed instanceof MarketFeed);
  feed.stop();
});

test('buildFeed falls back to demo data when the upstream fails, with a reason', async () => {
  const client = new ZebpayFuturesClient({
    transport: {
      async request() {
        throw new TransportError('SSL_ERROR_SYSCALL in connection to futuresbe.zebpay.com:443');
      },
    },
  });
  const { feed, mode, reason } = await buildFeed({ client, symbol: 'BTCINR' });
  assert.equal(mode, 'demo');
  assert.ok(feed instanceof DemoMarketFeed);
  assert.match(reason, /SSL_ERROR_SYSCALL/);
  feed.stop();
});

test('forceDemo skips the live attempt entirely', async () => {
  let called = 0;
  const client = new ZebpayFuturesClient({
    transport: {
      async request() {
        called += 1;
        return {};
      },
    },
  });
  const { feed, mode } = await buildFeed({ client, symbol: 'BTCINR', forceDemo: true });
  assert.equal(mode, 'demo');
  assert.equal(called, 0);
  feed.stop();
});

/* ── HTTP server ─────────────────────────────────────────────────────────── */

async function withServer(fn) {
  const { feed, mode } = await buildFeed({ client: liveClientStub(), symbol: 'BTCINR' });
  await feed.loadCandles('1m', 10);
  const server = createDashboardServer({ feed, symbol: 'BTCINR', mode });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, feed);
  } finally {
    feed.stop();
    await new Promise((r) => server.close(r));
  }
}

test('GET / serves the dashboard HTML', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /ZebPay Futures/);
    assert.match(body, /\/app\.js/);
  });
});

test('GET /app.js and /styles.css are served with the right MIME type', async () => {
  await withServer(async (base) => {
    const js = await fetch(base + '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const css = await fetch(base + '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    // Guard against a corrupted value sneaking back into the stylesheet.
    const body = await css.text();
    assert.ok(!/considered/.test(body));
  });
});

test('path traversal outside the public directory is refused', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/../../package.json');
    assert.ok(res.status === 404 || res.status === 403, `expected 403/404, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"zepayv3"'), 'package.json must not be served');
  });
});

test('GET /api/config reports the data mode and defaults to dry-run', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/config');
    const cfg = await res.json();
    assert.equal(cfg.symbol, 'BTCINR');
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.demo, false);
    assert.equal(cfg.orderMode, 'dry-run', 'no engine attached, so no live trading');
    assert.equal(cfg.botRunning, false);
  });
});

test('GET /api/snapshot returns book, spread and ticker', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/snapshot?levels=2');
    const snap = await res.json();
    assert.equal(snap.symbol, 'BTCINR');
    assert.equal(snap.bids.length, 2);
    assert.equal(snap.lastPrice, TICKER.last);
    assert.equal(snap.spread, 105);
  });
});

test('GET /api/candles returns normalized candles for the requested timeframe', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/candles?timeframe=5m&limit=10');
    const data = await res.json();
    assert.equal(data.timeframe, '5m');
    assert.equal(data.candles.length, 1);
    assert.equal(data.candles[0].close, 5550000);
  });
});

test('GET /api/bot reports idle state when no engine is attached', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/bot');
    const data = await res.json();
    assert.equal(data.running, false);
    assert.equal(data.status, null);
    assert.deepEqual(data.fills, []);
  });
});

test('GET /api/health reports feed counters', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/health');
    const h = await res.json();
    assert.equal(h.ok, true);
    assert.ok(h.feed.polls >= 1);
    assert.equal(h.feed.lastError, null);
  });
});

test('an unknown /api route 404s with JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/nope');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /unknown route/);
  });
});

test('GET /api/stream pushes an immediate snapshot then live updates', async () => {
  await withServer(async (base, feed) => {
    const controller = new AbortController();
    const res = await fetch(base + '/api/stream', { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];

    // Read until two snapshots have arrived (initial + one refresh).
    for (let i = 0; i < 40 && events.length < 2; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        if (!chunk.startsWith('event: snapshot')) continue;
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        events.push(JSON.parse(line.slice(5).trim()));
      }
      if (events.length < 2) await feed.refresh();
    }

    controller.abort();
    assert.ok(events.length >= 2, `expected >= 2 snapshots, got ${events.length}`);
    assert.equal(events[0].symbol, 'BTCINR');
  });
});

/* ── Resilience regressions ──────────────────────────────────────────────── */

test('a feed error does not crash a caller that never attached an error listener', async () => {
  const client = new ZebpayFuturesClient({
    transport: {
      async request() {
        throw new TransportError('upstream unreachable');
      },
    },
  });
  // Node rethrows an 'error' event with no listener. MarketFeed installs a
  // default no-op so a transient network failure cannot take down the process.
  const feed = new MarketFeed({ client, symbol: 'BTCINR' });
  assert.doesNotThrow(() => {
    feed.removeListener('error', feed.listeners('error')[0]);
    feed.on('error', () => {});
  });

  const bare = new MarketFeed({ client, symbol: 'BTCINR' });
  assert.equal(await bare.refresh(), false, 'returns false instead of throwing');
  assert.equal(bare.failures, 1);
});

test('DemoMarketFeed snapshots never contain NaN prices', async () => {
  const feed = new DemoMarketFeed({ now: () => 1000 });
  for (let i = 0; i < 20; i++) await feed.refresh();
  const snap = feed.snapshot();
  for (const [p, q] of [...snap.bids, ...snap.asks]) {
    assert.ok(Number.isFinite(p) && Number.isFinite(q), `non-finite level ${p}/${q}`);
  }
});
