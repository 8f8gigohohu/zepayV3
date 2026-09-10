import { envStr } from '../core/env.js';

/**
 * Environment variables the dashboard knows about, in the order `.env.example`
 * lists them. The Setup page renders this table, so it stays the single source
 * of truth for both.
 *
 * `secret: true` means the value must never leave the server — not to the
 * browser, not into a report, not into a log. Only its presence is reported.
 */
export const ENV_VARS = [
  { key: 'ZEBPAY_API_KEY', required: true, secret: true, purpose: 'API key from the ZebPay "API Trading" page' },
  { key: 'ZEBPAY_API_SECRET', required: true, secret: true, purpose: 'Used locally for HMAC-SHA256 signing; never transmitted' },
  { key: 'ZEBPAY_SUBACCOUNT_ID', required: false, secret: false, purpose: 'Optional subaccount; sent as the `subaccountid` header' },
  { key: 'ZEBPAY_ALLOW_LIVE', required: false, secret: false, purpose: 'First of two switches needed for real orders' },
  { key: 'ZEBPAY_FUTURES_BASE_URL', required: false, secret: false, purpose: 'REST base URL' },
  { key: 'ZEBPAY_FUTURES_WS_URL', required: false, secret: false, purpose: 'Private WebSocket base URL' },
  { key: 'ZEBPAY_REQUEST_TIMEOUT_MS', required: false, secret: false, purpose: 'Per-request timeout' },
  { key: 'ZEBPAY_MAX_RETRIES', required: false, secret: false, purpose: 'Retries before giving up on a request' },
  { key: 'ZEBPAY_STARTUP_TIMEOUT_MS', required: false, secret: false, purpose: 'Cap on the LIVE-vs-DEMO probe before falling back to demo' },
  { key: 'PORT', required: false, secret: false, purpose: 'Dashboard port' },
  { key: 'ZEBPAY_DASHBOARD_SYMBOL', required: false, secret: false, purpose: 'Default symbol for the dashboard' },
];

/**
 * Show enough of an identifier to recognise it, and nothing more.
 *
 * Four characters at each end is the usual convention for an API *key*, which is
 * an identifier rather than a credential. For short values even that can be most
 * of the string, so anything under 12 characters is fully masked.
 */
export function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length < 12) return '•'.repeat(Math.min(s.length, 8));
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Stricter mask for a *secret*, as opposed to a key.
 *
 * A key is an identifier, so showing its tail is harmless. A secret is the
 * credential itself, and there is no reason to reveal any part of its end — so
 * only a prefix is shown, enough to confirm which one is loaded.
 */
export function maskSecretValue(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length < 12) return '•'.repeat(Math.min(s.length, 8));
  return `${s.slice(0, 4)}… (${s.length} chars, hidden)`;
}

/**
 * Build the Setup page payload.
 *
 * Every value returned here is safe to render in a browser. Secrets are reduced
 * to a presence flag plus a masked fingerprint, and the masking happens here on
 * the server — the raw value is never serialised into the response at all.
 *
 * @param {object} args
 * @param {object} args.config   resolved runtime config
 * @param {'live'|'demo'} args.feedMode
 * @param {object} [args.env]    override for testing; defaults to process.env
 */
export function describeSetup({ config, feedMode, env = process.env } = {}) {
  const variables = ENV_VARS.map((v) => {
    const raw = env[v.key];
    const set = raw !== undefined && String(raw).trim() !== '';
    return {
      key: v.key,
      required: v.required,
      purpose: v.purpose,
      set,
      // Non-secret values are shown so the operator can confirm what is in
      // effect. Secrets are fingerprinted, never displayed — and the *secret*
      // is masked more aggressively than the key, because it is the credential.
      value: set && !v.secret ? String(raw).trim() : null,
      masked: set && v.secret
        ? (v.key === 'ZEBPAY_API_SECRET' ? maskSecretValue(raw) : maskSecret(raw))
        : null,
    };
  });

  const missingRequired = variables.filter((v) => v.required && !v.set).map((v) => v.key);

  return {
    variables,
    missingRequired,
    envFile: {
      path: '.env',
      location: 'repository root, next to package.json',
      gitignored: true,
      example: '.env.example',
    },
    credentials: {
      present: Boolean(config?.apiKey && config?.apiSecret),
      // A masked fingerprint lets an operator confirm which key is loaded
      // without ever putting the key on screen.
      keyFingerprint: config?.apiKey ? maskSecret(config.apiKey) : null,
      subaccountId: config?.subaccountId || null,
      note: 'The secret never leaves this process. It is used only to sign requests.',
    },
    endpoints: {
      rest: config?.baseUrl ?? envStr('ZEBPAY_FUTURES_BASE_URL', 'https://futuresbe.zebpay.com'),
      ws: config?.wsUrl ?? envStr('ZEBPAY_FUTURES_WS_URL', 'https://sp-futuresws.zebpay.com'),
    },
    trading: {
      allowLiveEnv: config?.allowLive === true,
      feedMode,
      // Both must hold. Stating the conjunction explicitly avoids the common
      // misreading that the env var alone is enough.
      realOrdersPossible: config?.allowLive === true && feedMode === 'live',
      note: 'Real orders need ZEBPAY_ALLOW_LIVE=true AND the --live flag AND live data.',
    },
    commands: [
      { label: 'Live market dashboard', command: 'npm run dashboard -- --port=4173' },
      { label: 'Live dashboard + dry-run bot', command: 'npm run dashboard -- --bot --port=4173' },
      { label: 'Demo dashboard (synthetic data)', command: 'npm run dashboard -- --demo --port=4173' },
      { label: 'AI decisions, evaluate only', command: 'node bin/zepay.js ai --cycles=3' },
      { label: 'Diagnostics', command: 'node bin/zepay.js doctor' },
      { label: 'Verify the real API', command: 'npm run check:live' },
    ],
  };
}
