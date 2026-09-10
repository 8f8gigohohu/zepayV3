import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoMarketFeed, MarketFeed } from './marketFeed.js';
import { normalizeSymbol } from '../core/symbols.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Dashboard HTTP server.
 *
 * Serves the static UI plus a thin JSON API. The server — not the browser — talks
 * to ZebPay, which sidesteps CORS on the public endpoints and keeps any API
 * credentials off the client entirely. Live updates reach the browser over
 * Server-Sent Events, which works through proxies without the upgrade handshake
 * that WebSockets need.
 *
 * @param {object} opts
 * @param {MarketFeed|DemoMarketFeed} opts.feed
 * @param {import('../strategy/engine.js').StrategyEngine} [opts.engine]
 * @param {string} [opts.symbol]
 * @param {'live'|'demo'} [opts.mode]
 */
export function createDashboardServer({ feed, engine, symbol = 'BTCINR', mode = 'live' }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/api/stream') return sse(req, res, feed);
      if (req.method === 'GET' && path.startsWith('/api/')) return api(req, res, url, { feed, engine, symbol, mode });
      return serveStatic(req, res, path);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // Keep a reference so callers can shut the feed down with the server.
  server.feed = feed;
  server.engine = engine;
  return server;
}

async function api(req, res, url, { feed, engine, symbol, mode }) {
  const path = url.pathname;

  switch (path) {
    case '/api/config':
      return sendJson(res, 200, {
        symbol: feed.symbol ?? normalizeSymbol(symbol),
        mode,
        demo: Boolean(feed.snapshot().demo),
        upstream: mode === 'demo' ? 'synthetic' : 'https://futuresbe.zebpay.com',
        botRunning: Boolean(engine?.running),
        orderMode: engine?.gateway?.mode ?? 'dry-run',
      });

    case '/api/snapshot':
      return sendJson(res, 200, feed.snapshot(Number(url.searchParams.get('levels') ?? 20)));

    case '/api/candles': {
      const timeframe = url.searchParams.get('timeframe') ?? '1m';
      const limit = Number(url.searchParams.get('limit') ?? 180);
      try {
        const candles = await feed.loadCandles(timeframe, limit);
        return sendJson(res, 200, { symbol: feed.symbol, timeframe, candles });
      } catch (err) {
        return sendJson(res, 200, { symbol: feed.symbol, timeframe, candles: feed.candles ?? [], error: err.message });
      }
    }

    case '/api/bot':
      return sendJson(res, 200, {
        running: Boolean(engine?.running),
        status: engine?.status() ?? null,
        fills: engine?.gateway?.fills?.slice(-50) ?? [],
      });

    case '/api/health':
      return sendJson(res, 200, {
        ok: feed.lastError === null || Boolean(feed.snapshot().demo),
        feed: { polls: feed.polls, failures: feed.failures, lastError: feed.lastError, updatedAt: feed.updatedAt },
      });

    default:
      return sendJson(res, 404, { error: `unknown route ${path}` });
  }
}

/** Server-Sent Events: push every feed update to all connected browsers. */
function sse(req, res, feed) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering so events are not held back
  });
  res.write(`retry: 2000\n\n`);

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('snapshot', feed.snapshot());

  const onUpdate = (snap) => send('snapshot', snap);
  feed.on('update', onUpdate);

  // Heartbeat so intermediaries do not consider the connection idle.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  ping.unref?.();

  req.on('close', () => {
    clearInterval(ping);
    feed.off('update', onUpdate);
    res.end();
  });
}

async function serveStatic(req, res, path) {
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  // Guard against `../` traversal before touching the filesystem.
  const filePath = resolve(PUBLIC_DIR, normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Build a feed, preferring live data and falling back to the demo feed when the
 * upstream is unreachable (no network, blocked host, etc.).
 *
 * @param {object} opts
 * @param {import('../client/ZebpayFutures.js').ZebpayFuturesClient} opts.client
 * @param {string} opts.symbol
 * @param {boolean} [opts.forceDemo]
 * @param {number} [opts.intervalMs]
 * @returns {Promise<{feed: MarketFeed|DemoMarketFeed, mode: 'live'|'demo', reason?: string}>}
 */
export async function buildFeed({ client, symbol, forceDemo = false, intervalMs = 2_000 }) {
  if (!forceDemo) {
    const live = new MarketFeed({ client, symbol, intervalMs });
    const ok = await live.refresh();
    if (ok) return { feed: live, mode: 'live' };
    const reason = live.lastError;
    live.stop();
    const demo = new DemoMarketFeed({ symbol, intervalMs: 1_000 });
    return { feed: demo, mode: 'demo', reason };
  }
  return { feed: new DemoMarketFeed({ symbol, intervalMs: 1_000 }), mode: 'demo' };
}
