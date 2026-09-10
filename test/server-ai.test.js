import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDashboardServer } from '../src/server/app.js';
import { DemoMarketFeed } from '../src/server/marketFeed.js';
import { buildAutonomous } from '../src/commands/ai-factory.js';

/**
 * Boot a dashboard with the AI stack attached.
 *
 * Uses a demo feed and a paper balance so the tests exercise the real decision
 * path without contacting ZebPay — the server, pipeline, risk engine, permission
 * engine and audit log are all the production ones.
 */
async function boot({ flags = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-srvai-'));
  const feed = new DemoMarketFeed({ symbol: 'BTCINR', intervalMs: 1_000 });
  await feed.start();

  const ai = buildAutonomous({
    client: {},
    config: {},
    flags: {
      auditFile: join(dir, 'audit.jsonl'),
      paperEquity: 100_000,
      minScore: 0.35,
      ...flags,
    },
    feed,
    feedMode: 'demo',
  });

  const server = createDashboardServer({ feed, symbol: 'BTCINR', mode: 'demo', ai });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    ai,
    feed,
    close: async () => {
      feed.stop();
      ai.killSwitch.removeAllListeners();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const get = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: parsed };
};

/* ── Disabled state ──────────────────────────────────────────────────────── */

test('AI routes report unavailable when the stack was not started', async () => {
  const feed = new DemoMarketFeed({ symbol: 'BTCINR' });
  const server = createDashboardServer({ feed, symbol: 'BTCINR', mode: 'demo' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, body } = await get(base, '/api/ai/status');
    assert.equal(status, 503);
    assert.match(body.error, /not enabled/);
  } finally {
    feed.stop();
    await new Promise((r) => server.close(r));
  }
});

/* ── Status and scan ─────────────────────────────────────────────────────── */

test('/api/ai/status reports the runner, account and order mode', async () => {
  const ctx = await boot();
  try {
    const { status, body } = await get(ctx.base, '/api/ai/status');
    assert.equal(status, 200);
    assert.equal(body.mode, 'demo');
    assert.equal(body.gatewayMode, 'dry-run', 'a demo feed can never go live');
    assert.equal(body.allowLive, false);
    assert.equal(body.account.equity, 100_000);
    assert.match(body.account.equitySource, /paper/);
    assert.equal(body.account.hasCredentials, false);
    assert.ok(body.runner.pipeline.killSwitch, 'kill switch state is exposed');
  } finally {
    await ctx.close();
  }
});

test('POST /api/ai/cycle runs a scan and returns a ranked table', async () => {
  const ctx = await boot();
  try {
    const { status, body } = await post(ctx.base, '/api/ai/cycle', {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.symbols, 1);
    assert.equal(body.ranked.length, 1);

    const row = body.ranked[0];
    assert.equal(row.symbol, 'BTCINR');
    // Every row must carry an explanation, including the model's own view —
    // "why not trading" is a requirement, not a nicety.
    assert.ok(typeof row.reason === 'string' && row.reason.length > 0);
    assert.ok('modelDirection' in row);
    assert.ok('score' in row);
  } finally {
    await ctx.close();
  }
});

test('/api/ai/trace returns a full trace and explains a missing symbol', async () => {
  const ctx = await boot();
  try {
    const missing = await get(ctx.base, '/api/ai/trace');
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /symbol is required/);

    const { status, body } = await get(ctx.base, '/api/ai/trace?symbol=BTCINR');
    assert.equal(status, 200);
    assert.equal(body.symbol, 'BTCINR');
    assert.ok(Array.isArray(body.reasons));
    assert.ok('stage' in body);
  } finally {
    await ctx.close();
  }
});

/* ── Health verdict ──────────────────────────────────────────────────────── */

test('/api/ai/health says PAPER ONLY on a synthetic feed, not READY', async () => {
  const ctx = await boot();
  try {
    await post(ctx.base, '/api/ai/cycle', {});
    const { body } = await get(ctx.base, '/api/ai/health');

    assert.equal(body.ok, false, 'a demo feed without credentials is not ready');
    assert.equal(body.verdict, 'PAPER ONLY');
    const names = body.checks.map((c) => c.name);
    assert.ok(names.includes('feed') && names.includes('credentials'));
    assert.equal(body.checks.find((c) => c.name === 'feed').ok, false);
    assert.match(body.checks.find((c) => c.name === 'account').detail, /paper/);
  } finally {
    await ctx.close();
  }
});

test('/api/ai/health reports NOT TRADING before any cycle has run', async () => {
  const ctx = await boot();
  try {
    const { body } = await get(ctx.base, '/api/ai/health');
    assert.equal(body.verdict, 'NOT TRADING');
  } finally {
    await ctx.close();
  }
});

/* ── Permissions ─────────────────────────────────────────────────────────── */

test('permissions can be read and toggled over the API', async () => {
  const ctx = await boot();
  try {
    const before = await get(ctx.base, '/api/ai/permissions');
    const row = before.body.permissions.find((p) => p.key === 'autonomousReentry');
    assert.equal(row.enabled, false);

    const set = await post(ctx.base, '/api/ai/permissions', { key: 'autonomousReentry', value: true, actor: 'test' });
    assert.equal(set.status, 200);
    assert.equal(set.body.value, true);
    assert.equal(ctx.ai.permissions.can('autonomousReentry'), true);

    const audit = await get(ctx.base, '/api/ai/audit?type=PERMISSION_CHANGED');
    assert.ok(audit.body.records.length >= 1, 'the change is audited');
  } finally {
    await ctx.close();
  }
});

test('withdrawals cannot be granted through the API', async () => {
  const ctx = await boot();
  try {
    const res = await post(ctx.base, '/api/ai/permissions', { key: 'withdrawal', value: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /forbidden/);
    assert.equal(ctx.ai.permissions.can('withdrawal'), false);
  } finally {
    await ctx.close();
  }
});

test('an unknown permission key is rejected, not silently created', async () => {
  const ctx = await boot();
  try {
    const res = await post(ctx.base, '/api/ai/permissions', { key: 'makeMoney', value: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unknown permission/);
  } finally {
    await ctx.close();
  }
});

/* ── Kill switch ─────────────────────────────────────────────────────────── */

test('the kill switch requires a reason and blocks trading once engaged', async () => {
  const ctx = await boot();
  try {
    const noReason = await post(ctx.base, '/api/ai/killswitch', { action: 'engage' });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /reason is required/);
    assert.equal(ctx.ai.killSwitch.blocked, false, 'nothing engaged without a reason');

    const engaged = await post(ctx.base, '/api/ai/killswitch', { action: 'engage', reason: 'test halt' });
    assert.equal(engaged.status, 200);
    assert.equal(engaged.body.status.blocked, true);

    const scan = await post(ctx.base, '/api/ai/cycle', {});
    assert.equal(scan.body.ranked[0].action, 'NO_TRADE');
    assert.match(scan.body.ranked[0].reason, /kill switch: test halt/);

    const resumed = await post(ctx.base, '/api/ai/killswitch', { action: 'resume', reason: 'test clear' });
    assert.equal(resumed.body.status.blocked, false);
  } finally {
    await ctx.close();
  }
});

test('an unknown kill switch action is rejected', async () => {
  const ctx = await boot();
  try {
    const res = await post(ctx.base, '/api/ai/killswitch', { action: 'selfDestruct', reason: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unknown action/);
  } finally {
    await ctx.close();
  }
});

/* ── Audit and routing ───────────────────────────────────────────────────── */

test('/api/ai/audit exposes a tail and a summary', async () => {
  const ctx = await boot();
  try {
    await post(ctx.base, '/api/ai/cycle', {});
    const { body } = await get(ctx.base, '/api/ai/audit?limit=5');
    assert.ok(body.records.length > 0);
    assert.ok(body.records.length <= 5, 'the limit is honoured');
    assert.ok(body.summary.total >= body.records.length);
    assert.ok(body.summary.byType.STARTUP >= 1);
    // No record may contain a raw secret key.
    const raw = JSON.stringify(body.records);
    assert.doesNotMatch(raw, /apiSecret|api_secret/);
  } finally {
    await ctx.close();
  }
});

test('unknown AI routes 404 and non-GET on market routes is refused', async () => {
  const ctx = await boot();
  try {
    assert.equal((await get(ctx.base, '/api/ai/nope')).status, 404);
    assert.equal((await get(ctx.base, '/api/ai/cycle')).status, 405, 'cycle is POST-only');
    assert.equal((await get(ctx.base, '/api/ai/killswitch')).status, 405, 'kill switch is POST-only');
    assert.equal((await post(ctx.base, '/api/snapshot', {})).status, 405);
  } finally {
    await ctx.close();
  }
});

test('a malformed or oversized JSON body degrades instead of crashing', async () => {
  const ctx = await boot();
  try {
    const bad = await fetch(ctx.base + '/api/ai/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400, 'an unparseable body has no key, so it is rejected');

    const huge = await fetch(ctx.base + '/api/ai/killswitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'engage', reason: 'x'.repeat(20_000) }),
    });
    // Oversized body is dropped, which leaves no reason — still a 400, not a hang.
    assert.equal(huge.status, 400);

    const after = await get(ctx.base, '/api/ai/status');
    assert.equal(after.status, 200, 'the server survived both');
  } finally {
    await ctx.close();
  }
});
