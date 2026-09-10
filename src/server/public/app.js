/* ZebPay Futures dashboard — dependency-free canvas chart + SSE client. */

const $ = (id) => document.getElementById(id);

const state = {
  symbol: 'BTCINR',
  timeframe: '1m',
  candles: [],
  snapshot: null,
  demo: false,
  /** 'live' | 'demo' | 'pending' */
  mode: 'pending',
  config: null,
  page: 'overview',
};

/* ── Formatting ──────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return n >= 1000
    ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-IN', { maximumFractionDigits: 4 });
}

function fmtNum(v, d = 3) {
  if (!Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('en-IN', { maximumFractionDigits: d });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour12: false });
}

function displayPair(symbol) {
  const s = String(symbol).toUpperCase();
  for (const q of ['USDT', 'INR']) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}-${q}`;
  }
  return s;
}

/* ── Candlestick chart ───────────────────────────────────────────────────── */

function drawChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
  const height = 360;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const candles = state.candles;
  if (!candles.length) {
    ctx.fillStyle = '#8a93a6';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('waiting for candles…', width / 2, height / 2);
    return;
  }

  const padL = 8;
  const padR = 74;
  const padT = 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let lo = Infinity;
  let hi = -Infinity;
  let maxVol = 0;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
    if (c.volume > maxVol) maxVol = c.volume;
  }
  const range = hi - lo || 1;
  lo -= range * 0.05;
  hi += range * 0.05;
  const span = hi - lo;

  const y = (price) => padT + plotH - ((price - lo) / span) * plotH;
  const slot = plotW / candles.length;
  const bodyW = Math.max(1, Math.min(11, slot * 0.65));

  // Horizontal grid + right-hand price axis.
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const price = lo + (span * i) / 4;
    const gy = y(price);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + plotW, gy);
    ctx.stroke();
    ctx.fillStyle = '#8a93a6';
    ctx.fillText(fmtPrice(price), padL + plotW + 8, gy + 4);
  }

  // Volume histogram in the lower fifth of the plot.
  const volH = plotH * 0.18;
  if (maxVol > 0) {
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const cx = padL + slot * (i + 0.5);
      const h = (c.volume / maxVol) * volH;
      ctx.fillStyle = c.close >= c.open ? 'rgba(38,166,154,0.28)' : 'rgba(239,83,80,0.28)';
      ctx.fillRect(cx - bodyW / 2, padT + plotH - h, bodyW, h);
    }
  }

  // Candles.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cx = padL + slot * (i + 0.5);
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
    ctx.fillStyle = up ? '#26a69a' : '#ef5350';

    ctx.beginPath();
    ctx.moveTo(cx, y(c.high));
    ctx.lineTo(cx, y(c.low));
    ctx.stroke();

    const yOpen = y(c.open);
    const yClose = y(c.close);
    const top = Math.min(yOpen, yClose);
    const h = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, h);
  }

  // Live price line.
  const last = state.snapshot?.lastPrice;
  if (last && last >= lo && last <= hi) {
    const ly = y(last);
    ctx.strokeStyle = 'rgba(247,147,26,0.75)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(padL + plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f7931a';
    ctx.fillRect(padL + plotW + 2, ly - 8, padR - 6, 16);
    ctx.fillStyle = '#16120b';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.fillText(fmtPrice(last), padL + plotW + 8, ly + 4);
  }

  // X axis: first / middle / last timestamps.
  ctx.fillStyle = '#8a93a6';
  ctx.font = '11px ui-monospace, monospace';
  const marks = [0, Math.floor(candles.length / 2), candles.length - 1];
  ctx.textAlign = 'center';
  for (const i of marks) {
    const c = candles[i];
    if (!c) continue;
    const cx = padL + slot * (i + 0.5);
    ctx.fillText(fmtTime(c.t), Math.min(Math.max(cx, 40), padL + plotW - 20), height - 8);
  }
}

/* ── Panels ──────────────────────────────────────────────────────────────── */

function renderSnapshot(snap) {
  state.snapshot = snap;
  state.symbol = snap.symbol;
  $('pairLabel').textContent = `${displayPair(snap.symbol)} · PERPETUAL`;

  const t = snap.ticker ?? {};
  const last = snap.lastPrice;
  $('lastPrice').textContent = fmtPrice(last);

  const chg = Number(t.change ?? 0);
  const pct = Number(t.percentage ?? 0);
  const chgEl = $('change');
  chgEl.textContent = `${chg >= 0 ? '+' : ''}${fmtNum(chg, 0)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  chgEl.className = `change ${chg >= 0 ? 'up' : 'down'}`;

  $('stats').innerHTML = [
    ['Open', fmtPrice(t.open)],
    ['24h High', fmtPrice(t.high)],
    ['24h Low', fmtPrice(t.low)],
    ['VWAP', fmtPrice(t.vwap)],
    ['Volume (base)', fmtNum(t.baseVolume, 2)],
    ['Best bid', fmtPrice(snap.bids?.[0]?.[0])],
    ['Best ask', fmtPrice(snap.asks?.[0]?.[0])],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  $('spread').textContent =
    snap.spread !== null && snap.spread !== undefined
      ? `spread ${fmtNum(snap.spread, 0)} (${Number(snap.spreadPct).toFixed(4)}%)`
      : '—';

  renderBook(snap);
  renderTrades(snap.trades ?? []);
  renderConnection(snap);
  // A canvas inside a hidden page has no client width, so drawing it is both
  // wasted work and produces a 0-width image that would have to be redrawn
  // anyway. The router calls drawChart() when the page becomes visible.
  if (state.page === 'market') drawChart();
}

function renderConnection(snap) {
  const el = $('connStats');
  if (!el) return;
  el.innerHTML = [
    ['Data mode', state.mode === 'live' ? 'LIVE (real ZebPay data)' : 'DEMO (synthetic data)'],
    ['Upstream', state.mode === 'live' ? 'https://futuresbe.zebpay.com' : 'none — generated locally'],
    ['Streaming', state.stream === 'open' ? 'connected (SSE)' : state.stream ?? 'connecting'],
    ['Last update', snap.updatedAt ? fmtTime(snap.updatedAt) : '—'],
    ['Polls', String(snap.polls ?? 0)],
    ['Failures', String(snap.failures ?? 0)],
    ['Last error', snap.lastError ?? 'none'],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');
}

/** Escape before interpolating into innerHTML — upstream strings are not ours. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderBook(snap) {
  const asks = (snap.asks ?? []).slice(0, 12).reverse();
  const bids = (snap.bids ?? []).slice(0, 12);
  const maxTotal = Math.max(
    ...[...asks, ...bids].map((l) => Number(l[0]) * Number(l[1]) || 0),
    1,
  );

  const row = (level, side) => {
    const [price, qty] = level;
    const total = Number(price) * Number(qty);
    const w = ((total / maxTotal) * 100).toFixed(1);
    return `<div class="row">
      <span class="bar ${side}" style="width:${w}%"></span>
      <span class="px ${side}">${fmtPrice(price)}</span>
      <span class="qty">${fmtNum(qty, 4)}</span>
      <span class="total">${fmtNum(total, 0)}</span>
    </div>`;
  };

  $('book').innerHTML =
    asks.map((l) => row(l, 'sell')).join('') +
    `<div class="spread-row">spread ${fmtNum(snap.spread, 0)}</div>` +
    bids.map((l) => row(l, 'buy')).join('');
}

function renderTrades(trades) {
  $('trades').innerHTML = trades
    .slice(0, 24)
    .map((t) => {
      const buy = t.isBuyerMarketMaker === false;
      return `<div class="trade">
        <span class="px ${buy ? 'buy' : 'sell'}">${fmtPrice(t.price)}</span>
        <span class="qty">${fmtNum(t.quantity, 4)}</span>
        <span class="time">${fmtTime(Number(t.tradeTime))}</span>
      </div>`;
    })
    .join('');
}

/* ── Data loading ────────────────────────────────────────────────────────── */

async function loadCandles() {
  try {
    const res = await fetch(`/api/candles?timeframe=${state.timeframe}&limit=180`);
    const data = await res.json();
    state.candles = data.candles ?? [];
    const first = state.candles[0];
    const last = state.candles.at(-1);
    $('chartMeta').textContent = first && last
      ? `${state.candles.length} candles · ${state.timeframe} · ${fmtTime(first.t)} → ${fmtTime(last.t)}`
      : 'no candles';
    drawChart();
  } catch (err) {
    $('chartMeta').textContent = `candles unavailable: ${err.message}`;
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.config = cfg;
    state.demo = cfg.demo;
    state.mode = cfg.mode;

    const badge = $('modeBadge');
    // LIVE / DEMO is the single most important fact on the page, so it is
    // stated in full words rather than left to colour alone.
    badge.textContent = cfg.demo ? 'DEMO — synthetic data' : 'LIVE — real ZebPay data';
    badge.className = `badge ${cfg.demo ? 'demo' : 'live'}`;

    const bot = $('botBadge');
    bot.textContent = cfg.botRunning ? `bot · ${cfg.orderMode}` : 'bot not running';
    bot.className = `badge ${cfg.botRunning ? 'live' : 'dim'}`;

    // Stack the warnings: demo data, upstream failures and live trading are
    // independent conditions and any of them can be true at once.
    const warnings = [];
    if (cfg.demo) {
      warnings.push(
        'DEMO MODE — these prices are synthetic and generated locally. They are not real ' +
        'ZebPay prices and must not be used for trading decisions. See the Fix Report page.',
      );
    }
    if (cfg.feedError) {
      warnings.push(`Upstream error: ${cfg.feedError}`);
    }
    if ((cfg.feedFailures ?? 0) > 0) {
      warnings.push(`${cfg.feedFailures} upstream request(s) have failed.`);
    }
    if (cfg.realOrdersAllowed) {
      warnings.push(
        'REAL ORDERS ARE ENABLED. Live trading is on and fills will be transmitted to ZebPay.',
      );
    }

    const b = $('banner');
    if (warnings.length) {
      b.textContent = '';
      for (const w of warnings) {
        const p = document.createElement('div');
        p.className = cfg.realOrdersAllowed && w.startsWith('REAL') ? 'banner-danger' : '';
        p.textContent = w;
        b.appendChild(p);
      }
      b.className = `banner ${cfg.realOrdersAllowed ? 'danger' : ''}`;
    } else {
      b.className = 'banner hidden';
    }

    if (state.page === 'overview') renderOverview();
  } catch (err) {
    const b = $('banner');
    b.textContent = `Could not read dashboard config: ${err.message}`;
    b.className = 'banner';
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  state.stream = 'connecting';

  es.onopen = () => {
    state.stream = 'open';
    $('linkBadge').textContent = 'streaming';
    $('linkBadge').className = 'badge live';
    if (state.page === 'market') renderConnection(state.snapshot ?? {});
  };

  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    renderSnapshot(snap);
    $('footStatus').textContent =
      `last update ${fmtTime(snap.updatedAt)} · poll #${snap.polls} · symbol ${snap.symbol}`;
  });

  es.onerror = () => {
    state.stream = 'reconnecting';
    $('linkBadge').textContent = 'reconnecting';
    $('linkBadge').className = 'badge dim';
    if (state.page === 'market') renderConnection(state.snapshot ?? {});
  };
}

/* ── Router ──────────────────────────────────────────────────────────────── */

const ROUTES = ['overview', 'market', 'bot', 'ai', 'setup', 'report'];

/** Per-page loaders, run on entry and on the page's own refresh interval. */
const PAGE_LOADERS = {
  overview: renderOverview,
  market: () => { loadCandles(); },
  bot: loadBot,
  ai: refreshAi,
  setup: loadSetup,
  report: loadReport,
};

function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(hash) ? hash : 'overview';
}

function navigate() {
  const route = currentRoute();
  state.page = route;

  for (const r of ROUTES) {
    $(`page-${r}`)?.classList.toggle('hidden', r !== route);
  }
  for (const a of $('nav').querySelectorAll('a[data-route]')) {
    a.classList.toggle('active', a.dataset.route === route);
  }

  // The chart canvas has no width while its page is hidden, so draw it now
  // that it is visible.
  if (route === 'market') drawChart();
  PAGE_LOADERS[route]?.();
}

/* ── Overview page ───────────────────────────────────────────────────────── */

function tile(label, value, tone = '', note = '') {
  return `<div class="tile ${tone}">
    <div class="tile-label">${escapeHtml(label)}</div>
    <div class="tile-value">${escapeHtml(value)}</div>
    ${note ? `<div class="tile-note">${escapeHtml(note)}</div>` : ''}
  </div>`;
}

async function renderOverview() {
  const cfg = state.config;
  const [bot, ai] = await Promise.all([
    fetch('/api/bot').then((r) => r.json()).catch(() => null),
    state.config?.aiEnabled
      ? fetch('/api/ai/health').then((r) => r.json()).catch(() => null)
      : Promise.resolve(null),
  ]);

  const price = state.snapshot?.lastPrice;
  const pct = Number(state.snapshot?.ticker?.percentage ?? 0);

  $('ovTiles').innerHTML = [
    tile('Data mode', cfg?.demo ? 'DEMO' : cfg ? 'LIVE' : 'loading',
      cfg?.demo ? 'warn' : 'ok',
      cfg?.demo ? 'synthetic — not real prices' : 'real ZebPay data'),
    tile('BTC-INR price', price ? fmtPrice(price) : '—', '',
      `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% / 24h`),
    tile('Bot', bot?.enabled ? (bot.running ? 'RUNNING' : 'STOPPED') : 'NOT ENABLED',
      bot?.running ? 'ok' : '',
      bot?.strategy ?? (bot?.enabled ? 'no strategy' : 'start with --bot')),
    tile('Order mode', bot?.mode ?? cfg?.orderMode ?? 'dry-run',
      cfg?.realOrdersAllowed ? 'danger' : 'ok',
      cfg?.realOrdersAllowed ? 'real orders possible' : 'simulated fills only'),
    tile('AI verdict', ai?.verdict ?? (cfg?.aiEnabled ? 'loading' : 'NOT ENABLED'),
      ai && !ai.ok ? 'warn' : '',
      cfg?.aiEnabled ? 'start with --ai' : ''),
  ].join('');

  $('ovSafety').innerHTML = [
    ['Real orders allowed', cfg?.realOrdersAllowed ? 'YES — live trading is on' : 'No — dry-run only'],
    ['Requires ZEBPAY_ALLOW_LIVE=true', 'and the --live flag, and live data'],
    ['Order endpoint in the browser', 'None. No page here can place an order.'],
    ['Kill switch', ai ? (ai.checks?.find((c) => c.name === 'kill switch')?.detail ?? 'unknown') : 'not running'],
    ['Secrets shown in this UI', 'Never. Keys are masked; secrets are not transmitted.'],
  ]
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');

  const links = [
    ['market', 'Live Market', 'price, chart, order book, recent trades'],
    ['bot', 'Bot Status', 'whether it is running, and why not if it is not'],
    ['ai', 'AI Decisions', 'model calls, vetoes and the audit trail'],
    ['setup', 'Setup', '.env, credentials, endpoints, commands'],
    ['report', 'Fix Report', 'problems, root causes and fixes, copyable'],
  ];
  $('ovLinks').innerHTML = links
    .map(([r, t, d]) => `<a class="link-card" href="#/${r}"><strong>${t}</strong><span>${d}</span></a>`)
    .join('');

  $('ovUpdated').textContent = `updated ${new Date().toLocaleTimeString('en-IN', { hour12: false })}`;
}

/* ── Bot page ────────────────────────────────────────────────────────────── */

async function loadBot() {
  const b = await fetch('/api/bot').then((r) => r.json()).catch(() => null);
  if (!b) {
    $('botHeadline').textContent = 'Could not read bot status.';
    return;
  }

  const badge = $('botStateBadge');
  const stateLabel = !b.enabled ? 'NOT ENABLED' : b.running ? 'RUNNING' : 'STOPPED';
  badge.textContent = stateLabel;
  badge.className = `badge ${b.running ? 'live' : 'dim'}`;

  $('botHeadline').textContent = b.idleReason
    ? `Not trading: ${b.idleReason}`
    : `Trading ${b.status?.symbol ?? ''} on ${b.status?.timeframe ?? '—'} in ${b.mode} mode.`;

  $('botStats').innerHTML = [
    ['Running', b.running ? 'yes' : 'no'],
    ['Strategy', b.strategy ?? '—'],
    ['Symbol', b.status?.symbol ?? '—'],
    ['Timeframe', b.status?.timeframe ?? '—'],
    ['Order mode', `${b.mode}${b.mode === 'live' ? ' (REAL ORDERS)' : ' (simulated)'}`],
    ['Warm-up', b.warmup ? `${b.warmup.done ? 'done' : 'in progress'} — ${b.warmup.candles} candles` : '—'],
    ['Ticks', String(b.status?.ticks ?? 0)],
    ['Fills', String(b.fillCount ?? 0)],
    ['Errors', String(b.errors ?? 0)],
    ['Started', b.status?.startedAt ? new Date(b.status.startedAt).toLocaleTimeString('en-IN', { hour12: false }) : '—'],
  ]
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');

  $('fillCount').textContent = `${b.fillCount ?? 0} total`;
  const tbody = $('fillTable').querySelector('tbody');
  tbody.textContent = '';
  const fills = b.fills ?? [];
  if (!fills.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = b.enabled ? 'no fills yet' : 'the bot is not enabled (start with --bot)';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const f of fills.slice(0, 50)) {
    const tr = document.createElement('tr');
    for (const v of [
      f.at ? fmtTime(f.at) : '—', f.mode ?? '—', f.side ?? '—', f.symbol ?? '—',
      fmtNum(f.amount, 6), fmtPrice(f.price), fmtNum(f.fee, 2),
    ]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const errEl = $('botErrors');
  if (!b.errors) {
    errEl.textContent = 'No errors recorded.';
    errEl.className = 'errors ok';
  } else {
    errEl.textContent = `${b.errors} error(s). Most recent: ${b.lastError ?? 'no detail captured'}`;
    errEl.className = 'errors bad';
  }
}

/* ── Setup page ──────────────────────────────────────────────────────────── */

async function loadSetup() {
  const s = await fetch('/api/setup').then((r) => r.json()).catch(() => null);
  if (!s) return;

  const tbody = $('envTable').querySelector('tbody');
  tbody.textContent = '';
  for (const v of s.variables) {
    const tr = document.createElement('tr');
    // Secrets are shown as a masked fingerprint only. The raw value never
    // reaches this response at all — see describeSetup() on the server.
    const shown = v.set ? (v.masked ?? v.value ?? '') : '';
    const cells = [
      v.key + (v.required ? ' *' : ''),
      v.set ? 'yes' : v.required ? 'MISSING' : 'not set',
      shown,
      v.purpose,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 1 && v.required && !v.set) td.className = 'bad';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  $('credStats').innerHTML = [
    ['Credentials loaded', s.credentials.present ? 'yes' : 'no'],
    ['Key fingerprint', s.credentials.keyFingerprint ?? '—'],
    ['Secret', 'never displayed, never transmitted'],
    ['Subaccount', s.credentials.subaccountId ?? 'main account'],
    ['Missing required', s.missingRequired.length ? s.missingRequired.join(', ') : 'none'],
  ]
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');

  $('endpointStats').innerHTML = [
    ['REST base URL', s.endpoints.rest],
    ['WebSocket URL', s.endpoints.ws],
    ['Real orders possible', s.trading.realOrdersPossible ? 'YES' : 'no'],
    ['Rule', s.trading.note],
  ]
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');

  $('cmdList').innerHTML = s.commands
    .map((c) => `<div class="cmd-row"><span>${escapeHtml(c.label)}</span><pre class="cmd">${escapeHtml(c.command)}</pre></div>`)
    .join('');
}

/* ── Fix Report page ─────────────────────────────────────────────────────── */

let reportText = '';

async function loadReport() {
  const r = await fetch('/api/report').then((x) => x.json()).catch(() => null);
  if (!r) return;
  reportText = r.text;

  const issues = r.entries.filter((e) => e.status === 'issue').length;
  $('reportMeta').textContent = `${r.entries.length - issues} ok · ${issues} issue(s)`;

  const list = $('reportList');
  list.textContent = '';
  for (const e of r.entries) {
    const box = document.createElement('div');
    box.className = `report-entry ${e.status}`;

    const head = document.createElement('div');
    head.className = 'report-head';
    head.textContent = `${e.status === 'ok' ? '✓' : '✗'} ${e.id} — ${e.severity}`;
    box.appendChild(head);

    for (const [label, value] of [
      ['Problem', e.problem],
      ['Root cause', e.rootCause],
      ['Fix', e.fix],
      ['Expected result', e.expected],
    ]) {
      const row = document.createElement('div');
      row.className = 'report-row';
      const k = document.createElement('strong');
      k.textContent = label;
      const v = document.createElement('div');
      v.className = 'report-value';
      v.textContent = value;
      row.append(k, v);
      box.appendChild(row);
    }
    list.appendChild(box);
  }
}

async function copyReport() {
  const btn = $('reportCopy');
  const pre = $('reportText');
  pre.textContent = reportText;
  pre.classList.remove('hidden');
  try {
    await navigator.clipboard.writeText(reportText);
    btn.textContent = 'Copied ✓';
  } catch {
    // Clipboard API needs a secure context; the text is already on screen so
    // the user can still select it manually.
    btn.textContent = 'Select the text below';
  }
  setTimeout(() => { btn.textContent = 'Copy as text'; }, 2500);
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

$('tfGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tf]');
  if (!btn) return;
  for (const b of $('tfGroup').children) b.classList.remove('active');
  btn.classList.add('active');
  state.timeframe = btn.dataset.tf;
  loadCandles();
});

$('reportCopy').addEventListener('click', copyReport);
$('reportRefresh').addEventListener('click', loadReport);

window.addEventListener('resize', () => {
  if (state.page === 'market') drawChart();
});
window.addEventListener('hashchange', navigate);

(async function boot() {
  await loadConfig();
  navigate();
  connectStream();
  initAi();
  // Refresh candles periodically so newly closed bars appear without a reload.
  setInterval(loadCandles, 30_000);
  // Keep the page you are looking at current.
  setInterval(() => {
    if (state.page === 'overview') renderOverview();
    if (state.page === 'bot') loadBot();
  }, 5_000);
})();

/* ── AI autonomous panel ─────────────────────────────────────────────────── */
/*
 * Self-contained: it activates only when the server was started with --ai, and
 * silently stays hidden otherwise. All state comes from the server; the browser
 * never talks to ZebPay and never holds a credential.
 */

const ai = { enabled: false, timer: null };

async function aiGet(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function aiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${path}`);
  return data;
}

function aiRow(cells, cls = '') {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.appendChild(td);
  }
  return tr;
}

function renderScan(rows) {
  const body = $('aiTable').querySelector('tbody');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(aiRow(['no symbols scanned yet', '', '', '', '', '']));
    return;
  }
  for (const r of rows) {
    const vetoed = r.modelDirection && r.modelDirection !== r.action;
    const outcome = vetoed ? `${r.modelDirection} vetoed` : r.action;
    body.appendChild(
      aiRow(
        [
          displayPair(r.symbol),
          r.modelDirection ?? '—',
          `${r.score ?? 0}%`,
          r.regime ?? '—',
          outcome,
          r.reason ?? r.why ?? '',
        ],
        r.action === 'NO_TRADE' ? 'no-trade' : 'acted',
      ),
    );
  }
}

function renderHealth(checks) {
  const el = $('aiHealth');
  el.textContent = '';
  for (const c of checks ?? []) {
    const d = document.createElement('div');
    d.className = `check ${c.ok ? 'ok' : 'bad'}`;
    d.textContent = `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`;
    el.appendChild(d);
  }
}

function renderPerms(permissions) {
  const el = $('aiPerms');
  el.textContent = '';
  for (const p of permissions ?? []) {
    const row = document.createElement('label');
    row.className = 'perm';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(p.enabled);
    // Forbidden capabilities cannot be granted, so the control is disabled —
    // showing an enabled toggle that silently does nothing would be worse.
    box.disabled = Boolean(p.forbidden);
    box.addEventListener('change', async () => {
      try {
        await aiPost('/api/ai/permissions', { key: p.key, value: box.checked, actor: 'dashboard' });
        await refreshAi();
      } catch (err) {
        box.checked = !box.checked;
        $('aiStatus').textContent = `permission error: ${err.message}`;
      }
    });
    row.appendChild(box);
    const span = document.createElement('span');
    span.textContent = `${p.label ?? p.key}${p.forbidden ? ' (forbidden)' : p.dangerous ? ' ⚠' : ''}`;
    span.title = p.key;
    row.appendChild(span);
    el.appendChild(row);
  }
}

function renderAudit(records) {
  const el = $('aiAudit');
  el.textContent = '';
  for (const r of (records ?? []).slice(-30).reverse()) {
    const line = document.createElement('div');
    line.className = 'audit-row';
    const at = r.at ? new Date(r.at).toLocaleTimeString('en-IN', { hour12: false }) : '';
    line.textContent = `${at} ${r.type}${r.data?.symbol ? ` ${r.data.symbol}` : ''}`;
    el.appendChild(line);
  }
}

async function refreshAi() {
  if (!ai.enabled) return;
  try {
    const [status, scan, health, perms, audit] = await Promise.all([
      aiGet('/api/ai/status'),
      aiGet('/api/ai/scan'),
      aiGet('/api/ai/health'),
      aiGet('/api/ai/permissions'),
      aiGet('/api/ai/audit?limit=30'),
    ]);

    const acc = status.account;
    const ks = status.runner.pipeline?.killSwitch;
    $('aiStatus').textContent =
      `cycle ${scan.cycle} · ${scan.symbols} symbols · ${scan.durationMs ?? '—'}ms · ` +
      `equity ${acc.equity > 0 ? acc.equity : 'unavailable'} (${acc.equitySource ?? 'unknown source'}) · ` +
      `orders ${status.gatewayMode} · live ${status.allowLive ? 'ALLOWED' : 'blocked'}` +
      `${ks?.blocked ? ' · ⛔ KILL SWITCH ENGAGED' : ''}`;

    $('aiVerdict').textContent = health.verdict;
    $('aiVerdict').className = `hint ${health.ok ? 'ok' : 'bad'}`;
    $('aiKill').textContent = ks?.blocked ? 'Resume' : 'Kill switch';
    $('aiKill').classList.toggle('armed', Boolean(ks?.blocked));

    renderHealth(health.checks);
    renderScan(scan.ranked ?? []);
    renderPerms(perms.permissions);
    renderAudit(audit.records);
  } catch (err) {
    $('aiStatus').textContent = `ai panel error: ${err.message}`;
  }
}

async function initAi() {
  try {
    const r = await fetch('/api/ai/status');
    if (!r.ok) return; // not started with --ai: leave the "not enabled" panel
  } catch {
    return;
  }
  ai.enabled = true;
  $('aiUnavailable').classList.add('hidden');
  $('aiCard').classList.remove('hidden');

  $('aiScanNow').addEventListener('click', async () => {
    $('aiScanNow').disabled = true;
    $('aiScanNow').textContent = 'scanning…';
    try {
      await aiPost('/api/ai/cycle', {});
      await refreshAi();
    } catch (err) {
      $('aiStatus').textContent = `scan error: ${err.message}`;
    } finally {
      $('aiScanNow').disabled = false;
      $('aiScanNow').textContent = 'Scan now';
    }
  });

  $('aiKill').addEventListener('click', async () => {
    const armed = $('aiKill').classList.contains('armed');
    const reason = window.prompt(
      armed ? 'Reason for resuming trading:' : 'Reason for engaging the kill switch:',
      armed ? 'operator resumed' : 'operator halt from dashboard',
    );
    if (!reason) return;
    try {
      await aiPost('/api/ai/killswitch', { action: armed ? 'resume' : 'engage', reason });
      await refreshAi();
    } catch (err) {
      $('aiStatus').textContent = `kill switch error: ${err.message}`;
    }
  });

  await refreshAi();
  ai.timer = setInterval(refreshAi, 10_000);
}
