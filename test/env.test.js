import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFlag, envInt, envStr, loadEnv, resolveConfig } from '../src/core/env.js';

let dir;
const saved = {};
const KEYS = [
  'ZEBPAY_API_KEY', 'ZEBPAY_API_SECRET', 'ZEBPAY_SUBACCOUNT_ID', 'ZEBPAY_ALLOW_LIVE',
  'ZEBPAY_FUTURES_BASE_URL', 'ZEBPAY_REQUEST_TIMEOUT_MS', 'ZEBPAY_MAX_RETRIES', 'TEST_VAR',
];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'zepay-env-'));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

test('loadEnv parses KEY=VALUE lines', () => {
  writeFileSync(join(dir, '.env'), 'ZEBPAY_API_KEY=abc123\nZEBPAY_API_SECRET=s3cr3t\n');
  const parsed = loadEnv(dir);
  assert.equal(parsed.ZEBPAY_API_KEY, 'abc123');
  assert.equal(process.env.ZEBPAY_API_KEY, 'abc123');
});

test('loadEnv skips comments, blanks and malformed lines', () => {
  writeFileSync(
    join(dir, '.env'),
    '# a comment\n\n   \nNOEQUALS\nZEBPAY_API_KEY=ok\n',
  );
  const parsed = loadEnv(dir);
  assert.deepEqual(Object.keys(parsed), ['ZEBPAY_API_KEY']);
});

test('loadEnv strips surrounding quotes', () => {
  writeFileSync(join(dir, '.env'), 'TEST_VAR="quoted value"\nZEBPAY_API_KEY=\'single\'\n');
  loadEnv(dir);
  assert.equal(process.env.TEST_VAR, 'quoted value');
  assert.equal(process.env.ZEBPAY_API_KEY, 'single');
});

test('loadEnv keeps an inline # as part of an unquoted value', () => {
  writeFileSync(join(dir, '.env'), 'ZEBPAY_API_KEY=abc#123\n');
  loadEnv(dir);
  assert.equal(process.env.ZEBPAY_API_KEY, 'abc#123');
});

test('a real environment variable wins over the file', () => {
  process.env.ZEBPAY_API_KEY = 'from-env';
  writeFileSync(join(dir, '.env'), 'ZEBPAY_API_KEY=from-file\n');
  loadEnv(dir);
  assert.equal(process.env.ZEBPAY_API_KEY, 'from-env');
});

test('loadEnv returns an empty object when no .env exists', () => {
  assert.deepEqual(loadEnv(dir), {});
});

test('envFlag only treats explicit truthy strings as true', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    process.env.TEST_VAR = v;
    assert.equal(envFlag('TEST_VAR'), true, `"${v}" should be truthy`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'maybe']) {
    process.env.TEST_VAR = v;
    assert.equal(envFlag('TEST_VAR'), false, `"${v}" should be falsy`);
  }
  delete process.env.TEST_VAR;
  assert.equal(envFlag('TEST_VAR'), false, 'unset defaults to false');
  assert.equal(envFlag('TEST_VAR', true), true, 'unset honours the fallback');
});

test('envStr and envInt handle missing and invalid values', () => {
  assert.equal(envStr('TEST_VAR', 'fallback'), 'fallback');
  process.env.TEST_VAR = '  spaced  ';
  assert.equal(envStr('TEST_VAR'), 'spaced');
  process.env.TEST_VAR = 'not-a-number';
  assert.equal(envInt('TEST_VAR', 42), 42, 'unparseable falls back');
  process.env.TEST_VAR = '99';
  assert.equal(envInt('TEST_VAR', 42), 99);
});

test('resolveConfig defaults to the documented endpoints and dry-run', () => {
  const c = resolveConfig();
  assert.equal(c.baseUrl, 'https://futuresbe.zebpay.com');
  assert.equal(c.wsUrl, 'https://sp-futuresws.zebpay.com');
  assert.equal(c.allowLive, false, 'live trading must never be the default');
  assert.equal(c.timeoutMs, 10_000);
  assert.equal(c.maxRetries, 4);
  assert.equal(c.apiKey, '');
});

test('resolveConfig picks up credentials and the kill switch from the environment', () => {
  writeFileSync(
    join(dir, '.env'),
    'ZEBPAY_API_KEY=K\nZEBPAY_API_SECRET=S\nZEBPAY_ALLOW_LIVE=true\nZEBPAY_SUBACCOUNT_ID=456\n',
  );
  loadEnv(dir);
  const c = resolveConfig();
  assert.equal(c.apiKey, 'K');
  assert.equal(c.apiSecret, 'S');
  assert.equal(c.subaccountId, '456');
  assert.equal(c.allowLive, true);
});

test('resolveConfig overrides beat the environment', () => {
  process.env.ZEBPAY_API_KEY = 'from-env';
  const c = resolveConfig({ apiKey: 'override', allowLive: true });
  assert.equal(c.apiKey, 'override');
  assert.equal(c.allowLive, true);
});
