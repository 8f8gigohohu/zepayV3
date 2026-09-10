import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` loader. Deliberately dependency-free and deliberately small:
 * it only fills keys that are not already present in `process.env`, so real
 * environment variables always win over the file (12-factor).
 *
 * @param {string} [cwd] Directory to look for `.env` in.
 * @returns {Record<string, string>} the values parsed from the file
 */
export function loadEnv(cwd = process.cwd()) {
  const file = resolve(cwd, '.env');
  const parsed = {};
  if (!existsSync(file)) return parsed;

  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes, honouring escaped quotes inside double-quoted values.
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
      if (rawLine.includes('"')) value = value.replace(/\\"/g, '"');
    }

    parsed[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Parse a boolean-ish env var. Anything not explicitly truthy is `false`. */
export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Read a string env var, treating empty as absent. */
export function envStr(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** Read an integer env var, falling back when unset or unparseable. */
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the full runtime configuration.
 *
 * Credentials are optional: everything public works without them, and the
 * client refuses private calls rather than sending an unsigned request.
 */
export function resolveConfig(overrides = {}) {
  return {
    apiKey: overrides.apiKey ?? envStr('ZEBPAY_API_KEY'),
    apiSecret: overrides.apiSecret ?? envStr('ZEBPAY_API_SECRET'),
    subaccountId: overrides.subaccountId ?? envStr('ZEBPAY_SUBACCOUNT_ID'),
    baseUrl: overrides.baseUrl ?? envStr('ZEBPAY_FUTURES_BASE_URL', 'https://futuresbe.zebpay.com'),
    wsUrl: overrides.wsUrl ?? envStr('ZEBPAY_FUTURES_WS_URL', 'https://sp-futuresws.zebpay.com'),
    timeoutMs: overrides.timeoutMs ?? envInt('ZEBPAY_REQUEST_TIMEOUT_MS', 10_000),
    maxRetries: overrides.maxRetries ?? envInt('ZEBPAY_MAX_RETRIES', 4),
    allowLive: overrides.allowLive ?? envFlag('ZEBPAY_ALLOW_LIVE', false),
  };
}
