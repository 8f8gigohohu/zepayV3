/* ZebPay Futures dashboard — dependency-free canvas chart + SSE client. */

const $ = (id) => document.getElementById(id);

const state = {
  symbol: 'BTCINR',
  timeframe: '1m',
  candles: [],
  snapshot: null,
  demo: false,
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
  drawChart();
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
    state.demo = cfg.demo;
    const badge = $('modeBadge');
    badge.textContent = cfg.demo ? 'demo data' : 'live';
    badge.className = `badge ${cfg.demo ? 'demo' : 'live'}`;

    const bot = $('botBadge');
    bot.textContent = cfg.botRunning ? `bot · ${cfg.orderMode}` : 'bot idle';
    bot.className = `badge ${cfg.botRunning ? 'live' : 'dim'}`;

    if (cfg.demo) {
      const b = $('banner');
      b.textContent =
        'Showing synthetic demo data — the ZebPay upstream is not reachable from this host. ' +
        'Run the dashboard from a machine that can reach futuresbe.zebpay.com for live prices.';
      b.classList.remove('hidden');
    }
  } catch {
    /* config is best-effort */
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    renderSnapshot(snap);
    $('linkBadge').textContent = 'streaming';
    $('linkBadge').className = 'badge live';
    $('footStatus').textContent =
      `last update ${fmtTime(snap.updatedAt)} · poll #${snap.polls} · symbol ${snap.symbol}`;
  });

  es.onerror = () => {
    $('linkBadge').textContent = 'reconnecting';
    $('linkBadge').className = 'badge dim';
  };
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

window.addEventListener('resize', drawChart);

loadConfig();
loadCandles();
connectStream();
// Refresh candles periodically so newly closed bars appear without a reload.
setInterval(loadCandles, 30_000);

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
    if (!r.ok) return; // not started with --ai: leave the panel hidden
  } catch {
    return;
  }
  ai.enabled = true;
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

initAi();
