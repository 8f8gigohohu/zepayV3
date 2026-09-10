import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERMISSIONS, PermissionEngine } from '../src/permissions/engine.js';
import { AuditLog, redact } from '../src/audit/log.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── Permissions ─────────────────────────────────────────────────────────── */

test('every dangerous capability defaults to NO', () => {
  const p = new PermissionEngine();
  for (const key of [
    'liveTrading', 'autonomousEntries', 'autonomousExits', 'autonomousReentry',
    'allowLeverageChanges', 'allowMarginChanges', 'allowPositionReduction',
    'allowPositionClosing', 'allowMultiplePositions', 'allowHighLeverage',
  ]) {
    assert.equal(p.can(key), false, `${key} must default to false`);
  }
});

test('safe reads default to YES', () => {
  const p = new PermissionEngine();
  for (const key of ['readMarketData', 'readBalance', 'readPositions', 'readOrders', 'paperTrading']) {
    assert.equal(p.can(key), true, `${key} should default to true`);
  }
});

test('live confirmation is required by default', () => {
  assert.equal(new PermissionEngine().can('requireLiveConfirmation'), true);
});

test('withdrawal can never be granted, even explicitly', () => {
  const p = new PermissionEngine({ withdrawal: true });
  assert.equal(p.can('withdrawal'), false, 'constructor override must be ignored');
  assert.throws(() => p.set('withdrawal', true), /forbidden platform-wide/);
});

test('enabling live trading is recorded for the audit trail', () => {
  const changes = [];
  const p = new PermissionEngine({}, (c) => changes.push(c));

  p.set('liveTrading', true, 'alice');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'liveTrading');
  assert.equal(changes[0].from, false);
  assert.equal(changes[0].to, true);
  assert.equal(changes[0].actor, 'alice');
});

test('setting a permission to its current value records nothing', () => {
  const changes = [];
  const p = new PermissionEngine({}, (c) => changes.push(c));
  p.set('liveTrading', false);
  assert.equal(changes.length, 0, 'no-op changes must not pollute the audit log');
});

test('unknown permissions are rejected', () => {
  const p = new PermissionEngine();
  assert.throws(() => p.set('launchMissiles', true), /unknown permission/);
  assert.equal(p.can('launchMissiles'), false);
});

test('require throws with an actionable message when denied', () => {
  const p = new PermissionEngine();
  assert.throws(
    () => p.require('autonomousEntries', 'open a position automatically'),
    (err) => {
      assert.match(err.message, /permission denied/);
      assert.match(err.message, /open a position automatically/);
      assert.match(err.message, /autonomousEntries/);
      return true;
    },
  );
});

test('live trading needs permission AND env flag AND CLI flag', () => {
  const p = new PermissionEngine();
  assert.equal(p.liveTradingAllowed({ allowLiveEnv: true, liveFlag: true }), false, 'permission missing');

  p.set('liveTrading', true);
  assert.equal(p.liveTradingAllowed({}), false, 'both switches missing');
  assert.equal(p.liveTradingAllowed({ allowLiveEnv: true }), false, 'CLI flag missing');
  assert.equal(p.liveTradingAllowed({ liveFlag: true }), false, 'env flag missing');
  assert.equal(p.liveTradingAllowed({ allowLiveEnv: true, liveFlag: true }), true);
});

test('describe marks dangerous and forbidden capabilities for the UI', () => {
  const rows = new PermissionEngine().describe();
  const live = rows.find((r) => r.key === 'liveTrading');
  assert.equal(live.dangerous, true);
  assert.equal(live.label, 'Enable LIVE trading (real money)');

  const wd = rows.find((r) => r.key === 'withdrawal');
  assert.equal(wd.forbidden, true);
  assert.equal(wd.enabled, false);
});

test('constructor overrides apply to known keys only', () => {
  const p = new PermissionEngine({ liveTrading: true, bogus: true });
  assert.equal(p.can('liveTrading'), true);
  assert.equal(p.permissions.bogus, undefined);
});

test('DEFAULT_PERMISSIONS itself is safe if someone imports it directly', () => {
  assert.equal(DEFAULT_PERMISSIONS.liveTrading, false);
  assert.equal(DEFAULT_PERMISSIONS.withdrawal, false);
});

/* ── Audit log ───────────────────────────────────────────────────────────── */

test('redact strips secret values at any depth', () => {
  const out = redact({
    apiKey: 'AK123',
    apiSecret: 'SUPERSECRET',
    nested: { signature: 'abc', token: 'jwt-here', safe: 'visible' },
    list: [{ password: 'p' }, { ok: 1 }],
  });
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.apiSecret, '[REDACTED]');
  assert.equal(out.nested.signature, '[REDACTED]');
  assert.equal(out.nested.token, '[REDACTED]');
  assert.equal(out.nested.safe, 'visible');
  assert.equal(out.list[0].password, '[REDACTED]');
  assert.equal(out.list[1].ok, 1);
});

test('redact never leaks even a prefix of a secret', () => {
  const out = redact({ apiSecret: 'abcdefghijkl' });
  assert.equal(out.apiSecret, '[REDACTED]');
  assert.ok(!JSON.stringify(out).includes('abc'));
});

test('the audit log records type, timestamp and redacted data', () => {
  const log = new AuditLog();
  const rec = log.record('AI_DECISION', { symbol: 'BTCINR', direction: 'LONG', apiSecret: 'x' });

  assert.equal(rec.type, 'AI_DECISION');
  assert.equal(rec.data.symbol, 'BTCINR');
  assert.equal(rec.data.apiSecret, '[REDACTED]');
  assert.ok(Number.isFinite(rec.at));
  assert.ok(rec.id);
});

test('the audit log requires a type', () => {
  const log = new AuditLog();
  assert.throws(() => log.record(''), /requires a type/);
});

test('the audit log is append-only — there is no delete or update API', () => {
  const log = new AuditLog();
  assert.equal(typeof log.delete, 'undefined');
  assert.equal(typeof log.remove, 'undefined');
  assert.equal(typeof log.update, 'undefined');
  assert.equal(typeof log.clear, 'undefined');
});

test('the audit log writes JSONL to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepay-audit-'));
  const file = join(dir, 'nested', 'audit.jsonl');
  try {
    const log = new AuditLog({ file });
    log.record('ORDER_SENT', { symbol: 'BTCINR' });
    log.record('RISK_VERDICT', { approved: true });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'ORDER_SENT');
    assert.equal(JSON.parse(lines[1]).type, 'RISK_VERDICT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a disk write failure does not crash the caller', () => {
  // Make the *target file* a directory: mkdir of the parent succeeds, but the
  // append fails with EISDIR. (Two earlier approaches failed badly — an
  // unwritable /proc path blocked forever, and a path under a regular file
  // threw out of the constructor instead of out of the write.)
  const dir = mkdtempSync(join(tmpdir(), 'zepay-audit-'));
  const asDir = join(dir, 'audit.jsonl');
  mkdirSync(asDir);
  try {
    const log = new AuditLog({ file: asDir });
    const errors = [];
    log.on('error', (e) => errors.push(e));

    assert.doesNotThrow(() => log.record('X', {}));
    assert.equal(log.records.length, 1, 'still recorded in memory');
    assert.equal(errors.length, 1, 'but the failure is surfaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tail filters by type and caps retained records', () => {
  const log = new AuditLog({ memoryCap: 5 });
  for (let i = 0; i < 10; i++) log.record(i % 2 ? 'A' : 'B', { i });

  assert.equal(log.records.length, 5, 'memory ring buffer is capped');
  assert.equal(log.count, 10, 'but the true count is preserved');
  assert.ok(log.tail(100, 'A').every((r) => r.type === 'A'));
});

test('summary counts records by type', () => {
  const log = new AuditLog();
  log.record('A');
  log.record('A');
  log.record('B');
  const s = log.summary();
  assert.equal(s.total, 3);
  assert.equal(s.byType.A, 2);
  assert.equal(s.byType.B, 1);
});
