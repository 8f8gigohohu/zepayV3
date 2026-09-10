import { maskSecret } from './setup.js';
import { redact } from '../audit/log.js';

/**
 * Build the Fix Report.
 *
 * Entries are derived from the actual runtime state, not a canned list — a
 * report that describes problems the system does not have is worse than no
 * report, because it sends the operator looking in the wrong place.
 *
 * Each entry has a stable `id`, a `status` of `ok` or `issue`, and the four
 * fields the report page renders: problem, root cause, exact fix, expected
 * result.
 *
 * @param {object} s
 * @param {object} s.config      resolved config (already redacted by callers)
 * @param {'live'|'demo'} s.feedMode
 * @param {string|null} [s.feedError]
 * @param {number} [s.feedFailures]
 * @param {number|null} [s.clockSkewMs]
 * @param {object|null} [s.bot]      engine.status() plus idleReason
 * @param {object|null} [s.ai]       `{ enabled, killSwitchBlocked, killSwitchReason, verdict }`
 * @param {boolean} [s.liveChecksPassed]  result of `npm run check:live`, if known
 */
export function buildFixReport(s = {}) {
  const {
    config = {},
    feedMode = 'live',
    feedError = null,
    feedFailures = 0,
    clockSkewMs = null,
    bot = null,
    ai = null,
    liveChecksPassed = null,
  } = s;

  const entries = [];
  const add = (e) => entries.push(e);

  // ── 1. Data mode. The single most important thing for a user to know. ────
  if (feedMode === 'demo') {
    add({
      id: 'DEMO_DATA',
      severity: 'high',
      status: 'issue',
      problem: 'The dashboard is showing synthetic DEMO data, not real ZebPay prices.',
      rootCause:
        'The live upstream could not be reached, or --demo was passed. ' +
        (feedError ? `Last upstream error: ${feedError}. ` : '') +
        'Demo prices are generated locally by a random walk and have no relationship to the market.',
      fix:
        '1. Confirm this machine can reach https://futuresbe.zebpay.com\n' +
        '2. Run: npm run check:live\n' +
        '3. If that passes, restart without --demo: npm run dashboard -- --port=4173\n' +
        '4. If it fails on DNS/TLS, the network or a proxy is blocking the host.',
      expected:
        'The banner reads LIVE, prices match api.zebpay.com, and check:live reports 10/10.',
    });
  } else {
    add({
      id: 'LIVE_DATA',
      severity: 'info',
      status: 'ok',
      problem: 'The dashboard is showing real ZebPay prices.',
      rootCause: 'The live upstream responded, so the feed is in live mode.',
      fix: 'None required.',
      expected: 'Banner reads LIVE; prices match the exchange.',
    });
  }

  // ── 2. Upstream failures while nominally live ───────────────────────────
  if (feedMode === 'live' && (feedFailures > 0 || feedError)) {
    add({
      id: 'UPSTREAM_FAILURES',
      severity: 'medium',
      status: 'issue',
      problem: `Upstream requests are failing (${feedFailures} recorded).`,
      rootCause: feedError ?? 'No error detail was captured.',
      fix:
        '1. Run: node bin/zepay.js time   (checks clock skew, the usual cause of 400s)\n' +
        '2. Run: npm run check:live      (checks every public endpoint)\n' +
        '3. A 429 means rate limiting — increase --pollMs.\n' +
        '4. A 403 means the API key is IP-restricted in the ZebPay dashboard.',
      expected: 'Failure count stops increasing and the banner shows no warning.',
    });
  }

  // ── 3. Credentials ──────────────────────────────────────────────────────
  const hasCreds = Boolean(config.apiKey && config.apiSecret);
  if (!hasCreds) {
    add({
      id: 'NO_CREDENTIALS',
      severity: 'medium',
      status: 'issue',
      problem: 'No API credentials are configured, so private data is unavailable.',
      rootCause:
        'ZEBPAY_API_KEY and ZEBPAY_API_SECRET are not set. Public market data works without ' +
        'them, but balance, positions and orders do not.',
      fix:
        '1. Copy .env.example to .env in the repository root\n' +
        '2. Create a key at https://api.zebpay.com under "API Trading"\n' +
        '3. Scope it fetch:details for reads, futures:trading for writes\n' +
        '4. Set ZEBPAY_API_KEY and ZEBPAY_API_SECRET in .env\n' +
        '5. Restart the dashboard. .env is gitignored and must stay that way.',
      expected:
        'node bin/zepay.js balance returns your wallet balance instead of an auth error.',
    });
  } else {
    add({
      id: 'CREDENTIALS',
      severity: 'info',
      status: 'ok',
      problem: 'API credentials are loaded.',
      rootCause: `Key fingerprint ${maskSecret(config.apiKey)}. The secret is never displayed.`,
      fix: 'None required.',
      expected: 'Private endpoints respond; no secret appears anywhere in the UI or logs.',
    });
  }

  // ── 4. Clock skew ───────────────────────────────────────────────────────
  if (clockSkewMs !== null && Math.abs(clockSkewMs) > 5_000) {
    add({
      id: 'CLOCK_SKEW',
      severity: 'high',
      status: 'issue',
      problem: `System clock is ${Math.round(clockSkewMs)} ms away from ZebPay's server.`,
      rootCause:
        'Signed requests carry a timestamp. ZebPay rejects any request whose timestamp is too ' +
        'far from its own clock, which surfaces as "400 Invalid or expired timestamp".',
      fix:
        '1. Sync the system clock (NTP)\n' +
        '2. Re-run: node bin/zepay.js time\n' +
        '3. In a container, the host clock is inherited — fix it on the host.',
      expected: 'Clock skew reports within a few hundred milliseconds.',
    });
  }

  // ── 5. Live trading safety. Always reported, because "disabled" is the
  //       expected state and must not look like a fault. ──────────────────
  const livePossible = config.allowLive === true && feedMode === 'live';
  add({
    id: 'LIVE_TRADING',
    severity: livePossible ? 'high' : 'info',
    status: livePossible ? 'issue' : 'ok',
    problem: livePossible
      ? 'REAL ORDERS ARE POSSIBLE in this process.'
      : 'Real orders are disabled. All fills are simulated (dry-run).',
    rootCause: livePossible
      ? 'ZEBPAY_ALLOW_LIVE=true is set and the feed is live. Passing --live as well would ' +
        'transmit real orders.'
      : `ZEBPAY_ALLOW_LIVE is ${config.allowLive ? 'true' : 'not true'}, and the feed is ${feedMode}. ` +
        'Real orders need the env var AND the --live flag AND live data.',
    fix: livePossible
      ? 'If this is not intended, unset ZEBPAY_ALLOW_LIVE and restart. There is no way to ' +
        'place an order from the browser, so nothing can happen by clicking the UI.'
      : 'None required — this is the safe default. To enable real trading deliberately: ' +
        'set ZEBPAY_ALLOW_LIVE=true, run on live data, and pass --live.',
    expected: livePossible
      ? 'The banner shows a live-trading warning at all times.'
      : 'Order mode reads dry-run; no request is ever sent to the trade endpoint.',
  });

  // ── 6. Bot state ────────────────────────────────────────────────────────
  if (!bot) {
    add({
      id: 'BOT_NOT_ENABLED',
      severity: 'info',
      status: 'ok',
      problem: 'The strategy bot is not running.',
      rootCause: 'The dashboard was started without --bot, so no engine was created.',
      fix: 'Restart with: npm run dashboard -- --bot --port=4173',
      expected: 'The Bot Status page shows "running" with a strategy name and fill count.',
    });
  } else if (!bot.running) {
    add({
      id: 'BOT_STOPPED',
      severity: 'medium',
      status: 'issue',
      problem: 'The bot exists but is not running.',
      rootCause: bot.idleReason ?? 'It was stopped or never started.',
      fix: 'Restart the dashboard with --bot. If it exits immediately, check the process log.',
      expected: 'The Bot Status page shows "running".',
    });
  } else if (!bot.warmup?.done) {
    add({
      id: 'BOT_WARMING_UP',
      severity: 'medium',
      status: 'issue',
      problem: 'The bot is running but has not finished loading candle history.',
      rootCause: bot.warmup?.error
        ? `Warm-up failed: ${bot.warmup.error}`
        : 'The klines request has not returned yet.',
      fix:
        '1. Wait a few seconds — history loads asynchronously and does not block the page\n' +
        '2. If it fails, run: node bin/zepay.js klines BTC-INR --tf=1m --limit=20\n' +
        '3. A timeout means the upstream is slow; raise ZEBPAY_REQUEST_TIMEOUT_MS.',
      expected: 'Warm-up shows "done" with a candle count, and signals begin.',
    });
  } else if (bot.errors > 0) {
    add({
      id: 'BOT_ERRORS',
      severity: 'medium',
      status: 'issue',
      problem: `The bot has recorded ${bot.errors} error(s).`,
      rootCause: bot.lastError ?? 'No detail was captured.',
      fix:
        '1. Read the dashboard process log for the stack trace\n' +
        '2. Run: node bin/zepay.js doctor\n' +
        '3. Errors do not stop the loop — it retries on the next poll.',
      expected: 'The error count stops increasing.',
    });
  } else {
    add({
      id: 'BOT_OK',
      severity: 'info',
      status: 'ok',
      problem: 'The bot is running and healthy.',
      rootCause: `Strategy ${bot.strategy ?? 'unknown'} on ${bot.timeframe ?? '—'}, ` +
        `mode ${bot.mode ?? 'dry-run'}, ${bot.fills ?? 0} fill(s), 0 errors.`,
      fix: 'None required.',
      expected: 'Fills accumulate when the strategy crosses; mode stays dry-run unless enabled.',
    });
  }

  // ── 7. Kill switch ──────────────────────────────────────────────────────
  if (ai?.enabled) {
    if (ai.killSwitchBlocked) {
      add({
        id: 'KILL_SWITCH',
        severity: 'high',
        status: 'issue',
        problem: 'The kill switch is ENGAGED. No new positions can be opened.',
        rootCause: ai.killSwitchReason ?? 'No reason was recorded.',
        fix:
          '1. Resolve whatever caused the stop\n' +
          '2. POST /api/ai/killswitch with {"action":"resume","reason":"..."} ' +
          'or use the Kill switch button\n' +
          '3. A resume also requires a reason, so the audit trail stays complete.',
        expected: 'The status bar shows the kill switch clear.',
      });
    } else {
      add({
        id: 'KILL_SWITCH_CLEAR',
        severity: 'info',
        status: 'ok',
        problem: 'The kill switch is clear.',
        rootCause: 'No manual stop or automatic breaker is latched.',
        fix: 'None required.',
        expected: 'The AI stack evaluates normally; risk and permissions still apply.',
      });
    }
  }

  // ── 8. Live API verification ────────────────────────────────────────────
  if (liveChecksPassed === false) {
    add({
      id: 'LIVE_CHECK_FAILED',
      severity: 'high',
      status: 'issue',
      problem: 'npm run check:live reported failures.',
      rootCause:
        'One or more public endpoints did not return the expected shape, or the host was ' +
        'unreachable. Response shapes may have changed upstream.',
      fix:
        '1. Run: npm run check:live   (from a machine that can reach ZebPay)\n' +
        '2. Compare shapes against https://github.com/zebpay/zebpay-api-references\n' +
        '3. If a shape changed, update the parser in src/core/symbols.js.',
      expected: 'check:live reports 10/10 and exits 0.',
    });
  }

  return entries;
}

/**
 * Render the report as plain text for the copy button.
 *
 * Redacted as a final safety net: even if a caller passed a config containing a
 * real secret, `redact()` replaces known secret keys before anything reaches
 * the clipboard.
 */
export function formatFixReport(entries, meta = {}) {
  const lines = [
    'ZEPAY DASHBOARD — FIX REPORT',
    `generated: ${new Date().toISOString()}`,
    `data mode: ${meta.feedMode ?? 'unknown'}`,
    `order mode: ${meta.orderMode ?? 'unknown'}`,
    '',
  ];

  for (const e of entries) {
    lines.push(
      `[${e.status === 'ok' ? 'OK' : 'ISSUE'}] ${e.id} (${e.severity})`,
      `  Problem:      ${e.problem}`,
      `  Root cause:   ${e.rootCause}`,
      `  Fix:`,
      ...e.fix.split('\n').map((l) => `    ${l}`),
      `  Expected:     ${e.expected}`,
      '',
    );
  }

  const issues = entries.filter((e) => e.status === 'issue').length;
  lines.push(`${entries.length - issues} ok · ${issues} issue(s)`);

  return redact(lines.join('\n'));
}
