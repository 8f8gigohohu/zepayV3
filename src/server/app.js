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
 * @param {object} [opts.ai] autonomous bundle from `buildAutonomous()`
 */
export function createDashboardServer({ feed, engine, symbol = 'BTCINR', mode = 'live', ai = null }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/api/stream') return sse(req, res, feed);
      if (path.startsWith('/api/')) return api(req, res, url, { feed, engine, symbol, mode, ai });
      return serveStatic(req, res, path);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // Keep a reference so callers can shut the feed down with the server.
  server.feed = feed;
  server.engine = engine;
  server.ai = ai;
  return server;
}

async function api(req, res, url, { feed, engine, symbol, mode, ai }) {
  const path = url.pathname;

  // ── Autonomous AI routes. Kept ahead of the GET switch because several are
  //    POST and all of them are operator controls, not read-only views.
  if (path.startsWith('/api/ai')) return aiApi(req, res, url, { ai, mode });

  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed on ${path}` });

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

/**
 * Autonomous-trading API.
 *
 * Every write route is an operator control that moves the system *toward*
 * safety or away from it deliberately, so each one is audited by the engines it
 * touches. Note what is deliberately absent: there is no endpoint that places an
 * order directly. The only path to an order runs through the pipeline's gate
 * sequence.
 */
async function aiApi(req, res, url, { ai, mode }) {
  const path = url.pathname;
  if (!ai) return sendJson(res, 503, { error: 'autonomous trading is not enabled (start with --ai)' });

  switch (path) {
    case '/api/ai/status':
      return sendJson(res, 200, {
        mode,
        runner: ai.runner.status(),
        account: {
          equity: ai.accountState.equity,
          equitySource: ai.accountState.equitySource,
          lastError: ai.accountState.lastError,
          lastCheckedAt: ai.accountState.lastCheckedAt,
          hasCredentials: ai.hasCredentials,
        },
        gatewayMode: ai.gateway.mode,
        allowLive: ai.allowLive,
      });

    case '/api/ai/scan': {
      const result = ai.runner.lastResult;
      return sendJson(res, 200, {
        cycle: result?.cycle ?? 0,
        at: result?.at ?? null,
        ok: result?.ok ?? false,
        error: result?.error ?? null,
        symbols: result?.symbols ?? 0,
        durationMs: result?.durationMs ?? null,
        ranked: result?.ranked ?? [],
        acted: result?.acted?.trace
          ? { symbol: result.acted.trace.symbol, action: result.acted.trace.action }
          : null,
      });
    }

    // Full trace for one symbol: the "why not trading" answer, without
    // executing anything.
    case '/api/ai/trace': {
      const sym = url.searchParams.get('symbol');
      if (!sym) return sendJson(res, 400, { error: 'symbol is required' });
      try {
        return sendJson(res, 200, await ai.pipeline.evaluate(sym));
      } catch (err) {
        return sendJson(res, 200, { symbol: sym, action: 'NO_TRADE', reasons: [err.message], stage: 'error' });
      }
    }

    case '/api/ai/cycle': {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
      const result = await ai.runner.cycle();
      return sendJson(res, 200, { ok: result.ok, error: result.error, ranked: result.ranked, symbols: result.symbols });
    }

    case '/api/ai/permissions':
      if (req.method === 'GET') return sendJson(res, 200, { permissions: ai.permissions.describe(), snapshot: ai.permissions.snapshot() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body.key) return sendJson(res, 400, { error: 'key is required' });
        try {
          const value = ai.permissions.set(body.key, Boolean(body.value), body.actor ?? 'dashboard');
          return sendJson(res, 200, { key: body.key, value, permissions: ai.permissions.snapshot() });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      return sendJson(res, 405, { error: `${req.method} not allowed` });

    case '/api/ai/killswitch': {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'POST required', status: ai.killSwitch.status() });
      }
      const body = await readBody(req);
      const action = body.action ?? 'engage';
      // Every transition needs a reason — an unexplained kill-switch change is
      // exactly what an audit trail must not contain.
      if (!body.reason) return sendJson(res, 400, { error: 'a reason is required' });
      try {
        if (action === 'engage') ai.killSwitch.engage(body.reason);
        else if (action === 'resume') ai.killSwitch.resume(body.reason);
        else if (action === 'resetBreaker') { ai.killSwitch.resetBreaker(); ai.audit.record('BREAKER_RESET', { reason: body.reason }); }
        else return sendJson(res, 400, { error: `unknown action ${action}` });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, { status: ai.killSwitch.status() });
    }

    case '/api/ai/audit': {
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
      const type = url.searchParams.get('type') ?? null;
      return sendJson(res, 200, { records: ai.audit.tail(limit, type), summary: ai.audit.summary() });
    }

    case '/api/ai/health': {
      // Probes the upstream the way the runner would, so the UI can show a
      // real readiness answer rather than an assumption.
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      try {
        const account = await ai.fetchAccount();
        add('account', account.equity > 0,
          account.equity > 0
            ? `equity ${account.equity} from ${ai.accountState.equitySource}`
            : `unavailable — ${ai.accountState.lastError ?? 'unknown'}`);
      } catch (err) {
        add('account', false, err.message);
      }
      add('credentials', ai.hasCredentials, ai.hasCredentials ? 'api key + secret present' : 'missing');
      add('feed', mode === 'live', mode === 'live' ? 'live upstream' : 'synthetic demo data');
      add('universe', ai.runner.symbols.length > 0,
        `${ai.runner.symbols.length} symbols${ai.runner.universeError ? ` (${ai.runner.universeError})` : ''}`);
      add('kill switch', !ai.killSwitch.blocked, ai.killSwitch.blocked ? ai.killSwitch.reason : 'clear');
      add('autonomous entries', ai.permissions.can('autonomousEntries'),
        ai.permissions.can('autonomousEntries') ? 'enabled' : 'disabled');
      const ok = checks.every((c) => c.ok);
      // Three honest verdicts rather than one boolean. "NOT TRADING" is reserved
      // for a pipeline that genuinely cannot evaluate; a functioning pipeline on
      // synthetic data or without credentials is *paper only*, which is a very
      // different statement and must not be dressed up as either failure or
      // readiness for live money.
      const pipelineWorking = ai.runner.lastResult?.ok ?? false;
      const verdict = !pipelineWorking
        ? 'NOT TRADING'
        : ok && ai.allowLive
          ? 'READY (LIVE)'
          : 'PAPER ONLY';
      return sendJson(res, 200, { ok, verdict, checks });
    }

    default:
      return sendJson(res, 404, { error: `unknown route ${path}` });
  }
}

/** Parse a small JSON request body. Returns `{}` rather than throwing on junk. */
async function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    let oversized = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (oversized) return;
      // Check *after* appending: a single chunk larger than the cap would
      // otherwise sail through untouched, which is the common case.
      raw += chunk;
      if (raw.length > limit) {
        oversized = true;
        raw = ''; // drop it; the handler replies 400 rather than parsing junk
      }
    });
    req.on('end', () => {
      if (oversized) return finish({});
      try {
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
  });
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
  // The operator asked for demo data, so there is no upstream failure to
  // report — saying "unavailable (unknown)" here would be misleading.
  return {
    feed: new DemoMarketFeed({ symbol, intervalMs: 1_000 }),
    mode: 'demo',
    reason: 'demo mode requested (--demo); live upstream was not contacted',
  };
}
