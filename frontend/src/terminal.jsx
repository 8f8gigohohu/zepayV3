import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CandlestickChart,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Maximize2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Settings2,
  Sparkles,
  Square,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { CandlestickSeries, ColorType, LineSeries, createChart } from 'lightweight-charts';
import { api, ApiError, wsUrl } from './api.js';
import { useTerminalStore } from './store.js';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

const money = (value, compact = false) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: compact && Math.abs(number) >= 100000 ? 0 : 2,
    maximumFractionDigits: compact && Math.abs(number) >= 100000 ? 1 : 2,
    notation: compact && Math.abs(number) >= 100000 ? 'compact' : 'standard',
  }).format(number);
};

const quantity = (value, digits = 8) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('en-IN', { maximumFractionDigits: digits });
};

const clock = (value) => {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const dateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const shortSymbol = (symbol = '') => symbol.replace('/', ' / ');
const positiveClass = (value) => Number(value) >= 0 ? 'positive' : 'negative';

function notify(message, tone = 'neutral') {
  const store = useTerminalStore.getState();
  const id = Date.now();
  store.setToast({ message, tone, id });
  window.setTimeout(() => {
    if (useTerminalStore.getState().toast?.id === id) store.setToast(null);
  }, 3800);
}

async function loadPair(symbol, timeframe) {
  const state = useTerminalStore.getState();
  state.set({ feedState: 'connecting' });
  const params = new URLSearchParams({ symbol });
  const candleParams = new URLSearchParams({ symbol, timeframe, limit: '180' });
  const bookParams = new URLSearchParams({ symbol, limit: '40' });
  const tradeParams = new URLSearchParams({ symbol, limit: '35' });
  const [quoteResult, candlesResult, bookResult, tradesResult] = await Promise.allSettled([
    api(`/api/market?${params}`),
    api(`/api/candles?${candleParams}`),
    api(`/api/market/orderbook?${bookParams}`),
    api(`/api/market/trades?${tradeParams}`),
  ]);
  const patch = {};
  if (quoteResult.status === 'fulfilled') {
    state.setQuote(quoteResult.value);
    patch.feedState = quoteResult.value.is_simulated ? 'simulated' : 'connected';
  } else {
    patch.feedState = 'unavailable';
  }
  if (candlesResult.status === 'fulfilled') patch.candles = candlesResult.value.candles || [];
  else patch.candles = [];
  if (bookResult.status === 'fulfilled') patch.orderBook = bookResult.value;
  if (tradesResult.status === 'fulfilled') patch.marketTrades = tradesResult.value.trades || [];
  patch.lastUpdate = Date.now();
  state.set(patch);
  if (quoteResult.status === 'rejected') throw quoteResult.reason;
}

async function loadAccount() {
  const state = useTerminalStore.getState();
  if (state.mode === 'live' && !state.authenticated) return;
  const endpoints = [
    ['portfolio', '/api/portfolio'],
    ['positions', '/api/positions'],
    ['orders', '/api/orders?limit=100'],
    ['journal', '/api/journal/trades?limit=40&offset=0'],
    ['risk', '/api/risk'],
    ['strategy', '/api/strategy/status'],
  ];
  const values = await Promise.allSettled(endpoints.map(([, path]) => api(path)));
  const patch = {};
  values.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      if (result.reason?.status === 401) {
        patch.authenticated = false;
        patch.portfolio = null;
        patch.positions = [];
      }
      return;
    }
    const [key] = endpoints[index];
    if (key === 'portfolio') patch.portfolio = result.value;
    if (key === 'positions') patch.positions = result.value.positions || [];
    if (key === 'orders') patch.orders = result.value.orders || [];
    if (key === 'journal') {
      patch.journal = result.value.trades || [];
      patch.journalTotal = result.value.total || 0;
    }
    if (key === 'risk') patch.risk = result.value;
    if (key === 'strategy') patch.strategy = result.value;
  });
  state.set(patch);
}

async function loadForecast() {
  const result = await api('/api/strategy/forecast');
  useTerminalStore.getState().set({ forecast: result });
  return result;
}

function StatusDot({ state = 'muted' }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function SectionTitle({ eyebrow, title, action }) {
  return (
    <div className="section-title-row">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function MetricCard({ label, value, detail, icon: Icon, tone = 'normal', tag }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={16} strokeWidth={1.7} /></span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-bottom"><span>{detail}</span>{tag && <span className="metric-tag">{tag}</span>}</div>
    </article>
  );
}

function CandleChart({ candles, forecast }) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const forecastRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0c1118' },
        textColor: '#7e8a9a',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(99, 116, 139, 0.08)' },
        horzLines: { color: 'rgba(99, 116, 139, 0.1)' },
      },
      rightPriceScale: { borderColor: '#1b2632', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: '#1b2632', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { vertLine: { color: 'rgba(214, 167, 88, 0.25)' }, horzLine: { color: 'rgba(214, 167, 88, 0.25)' } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#31c996',
      downColor: '#f26c82',
      borderUpColor: '#31c996',
      borderDownColor: '#f26c82',
      wickUpColor: '#31c996',
      wickDownColor: '#f26c82',
      priceLineVisible: true,
      lastValueVisible: true,
    });
    const forecastSeries = chart.addSeries(LineSeries, {
      color: '#d6a758',
      lineWidth: 2,
      lineStyle: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
    });
    chartRef.current = chart;
    candleRef.current = candleSeries;
    forecastRef.current = forecastSeries;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      forecastRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleRef.current) return;
    const data = (candles || [])
      .filter((item) => Array.isArray(item) && item.length >= 6 && Number(item[4]) > 0)
      .map((item) => ({
        time: Math.floor(Number(item[0]) / 1000),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
      }))
      .sort((a, b) => a.time - b.time);
    candleRef.current.setData(data);
    if (chartRef.current && data.length) chartRef.current.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (!forecastRef.current) return;
    const points = (forecast?.forecast_candles || [])
      .filter((item) => Number(item.close) > 0)
      .map((item) => ({ time: Math.floor(Number(item.timestamp) / 1000), value: Number(item.close) }))
      .sort((a, b) => a.time - b.time);
    forecastRef.current.setData(points);
  }, [forecast]);

  return <div className="chart-host" ref={hostRef} />;
}

function ChartPanel() {
  const symbol = useTerminalStore((state) => state.symbol);
  const timeframe = useTerminalStore((state) => state.timeframe);
  const candles = useTerminalStore((state) => state.candles);
  const quote = useTerminalStore((state) => state.quotes[state.symbol]);
  const forecast = useTerminalStore((state) => state.forecast);
  const [expanded, setExpanded] = useState(false);
  const store = useTerminalStore.getState();
  const base = symbol.split('/')[0];
  const change = Number(quote?.percentage);

  return (
    <section className={`panel chart-panel ${expanded ? 'expanded' : ''}`}>
      <div className="chart-heading">
        <div className="asset-title">
          <span className={`asset-coin ${base.toLowerCase()}`}>{base === 'BTC' ? '₿' : base === 'ETH' ? '◆' : base.slice(0, 1)}</span>
          <div><div className="pair-line"><h2>{shortSymbol(symbol)}</h2><span className="spot-tag">SPOT</span></div><span className="subtle">ZebPay order book · {timeframe} candles</span></div>
        </div>
        <div className="chart-quote">
          <strong>{money(quote?.last)}</strong>
          <span className={Number.isFinite(change) ? positiveClass(change) : 'muted-text'}>{Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}</span>
        </div>
      </div>
      <div className="chart-toolbar">
        <div className="timeframe-tabs" role="group" aria-label="Candle timeframe">
          {TIMEFRAMES.map((frame) => <button key={frame} className={timeframe === frame ? 'active' : ''} onClick={() => { store.set({ timeframe: frame }); loadPair(symbol, frame).catch(() => {}); }}>{frame}</button>)}
        </div>
        <div className="chart-toolbar-right">
          {forecast?.available && <span className="forecast-legend"><i /> Kronos / fallback forecast</span>}
          <button className="icon-ghost" title="Toggle chart height" onClick={() => setExpanded((value) => !value)}><Maximize2 size={15} /></button>
        </div>
      </div>
      <div className="chart-body"><CandleChart candles={candles} forecast={forecast} />{!candles.length && <div className="chart-empty"><CandlestickChart size={26} /><strong>No candle history available</strong><span>Waiting for ZebPay market data. No sample candles are shown.</span></div>}</div>
      <div className="chart-footer"><span><StatusDot state={candles.length ? 'online' : 'muted'} /> ZebPay public market data · {candles.length} candles</span><span>FORECASTS ARE UNCERTAIN · NOT INVESTMENT ADVICE</span></div>
    </section>
  );
}

function BookPanel() {
  const book = useTerminalStore((state) => state.orderBook);
  const trades = useTerminalStore((state) => state.marketTrades);
  const symbol = useTerminalStore((state) => state.symbol);
  const bids = (book?.bids || []).slice(0, 8);
  const asks = (book?.asks || []).slice(0, 8).reverse();
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  const spread = bid && ask ? ((Number(ask) - Number(bid)) / Number(ask)) * 100 : null;

  return (
    <section className="panel orderbook-panel">
      <div className="panel-head compact-head"><div><div className="eyebrow">LIVE DEPTH</div><h2>Order book</h2></div><span className="subtle">{symbol}</span></div>
      <div className="book-columns"><span>PRICE <small>(INR)</small></span><span>AMOUNT <small>({symbol.split('/')[0]})</small></span></div>
      <div className="book-side asks">
        {asks.length ? asks.map((row, index) => <div className="book-row" key={`a-${index}`}><span>{money(row[0])}</span><span>{quantity(row[1])}</span><i style={{ width: `${Math.max(12, Math.min(100, Number(row[1]) * 450))}%` }} /></div>) : <div className="empty-mini">No ask depth available</div>}
      </div>
      <div className="spread-row"><strong>{bid && ask ? money((Number(bid) + Number(ask)) / 2) : '—'}</strong><span>{spread === null ? 'Spread —' : `Spread ${spread.toFixed(3)}%`}</span></div>
      <div className="book-side bids">
        {bids.length ? bids.map((row, index) => <div className="book-row" key={`b-${index}`}><span>{money(row[0])}</span><span>{quantity(row[1])}</span><i style={{ width: `${Math.max(12, Math.min(100, Number(row[1]) * 450))}%` }} /></div>) : <div className="empty-mini">No bid depth available</div>}
      </div>
      <div className="recent-trades-head"><span>RECENT PUBLIC TRADES</span><span>{trades.length} prints</span></div>
      <div className="recent-trades-table">
        <div className="trades-header"><span>PRICE</span><span>SIZE</span><span>TIME</span></div>
        {trades.slice(0, 6).map((trade, index) => <div className="trade-row" key={trade.id || index}><span className={String(trade.side).toLowerCase() === 'buy' ? 'positive' : 'negative'}>{money(trade.price)}</span><span>{quantity(trade.amount)}</span><span>{clock(trade.timestamp)}</span></div>)}
        {!trades.length && <div className="empty-mini">Waiting for exchange prints</div>}
      </div>
    </section>
  );
}

function Watchlist({ symbols }) {
  const active = useTerminalStore((state) => state.symbol);
  const quotes = useTerminalStore((state) => state.quotes);
  const store = useTerminalStore.getState();
  return (
    <div className="watchlist-row">
      <div className="watch-label"><span className="pulse-ring" /> WATCHLIST</div>
      {symbols.map((symbol) => {
        const quote = quotes[symbol];
        const change = Number(quote?.percentage);
        return <button key={symbol} className={`watch-item ${active === symbol ? 'selected' : ''}`} onClick={() => { store.set({ symbol }); loadPair(symbol, store.timeframe).catch(() => {}); }}>
          <span className={`watch-coin ${symbol.startsWith('BTC') ? 'btc' : 'eth'}`}>{symbol.startsWith('BTC') ? '₿' : '◆'}</span>
          <span className="watch-name"><strong>{symbol}</strong><small>{symbol.startsWith('BTC') ? 'Bitcoin' : symbol.startsWith('ETH') ? 'Ethereum' : 'Spot market'}</small></span>
          <span className="watch-price"><strong>{money(quote?.last)}</strong><small className={Number.isFinite(change) ? positiveClass(change) : 'muted-text'}>{Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}</small></span>
        </button>;
      })}
      <div className="watchlist-source"><StatusDot state={useTerminalStore.getState().feedState === 'connected' ? 'online' : 'muted'} /> REAL EXCHANGE FEED</div>
    </div>
  );
}

function OrderTicket() {
  const side = useTerminalStore((state) => state.side);
  const symbol = useTerminalStore((state) => state.symbol);
  const quote = useTerminalStore((state) => state.quotes[symbol]);
  const mode = useTerminalStore((state) => state.mode);
  const authenticated = useTerminalStore((state) => state.authenticated);
  const [amount, setAmount] = useState('0.0001');
  const [price, setPrice] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const store = useTerminalStore.getState();
  const base = symbol.split('/')[0];
  const portfolio = useTerminalStore((state) => state.portfolio);
  const currentQuote = side === 'buy' ? (quote?.ask || quote?.last) : (quote?.bid || quote?.last);
  const total = Number(price) * Number(amount);
  const blocked = !Number(price) || !Number(amount) || !Number.isFinite(total) || total <= 0 || mode === 'live';

  useEffect(() => {
    setPriceTouched(false);
  }, [symbol, side]);

  useEffect(() => {
    if (!priceTouched && quote) setPrice(String(side === 'buy' ? (quote.ask || quote.last) : (quote.bid || quote.last)));
  }, [quote?.last, quote?.ask, quote?.bid, priceTouched, side]);

  const setSide = (next) => {
    store.set({ side: next });
  };

  const fillFromMarket = () => {
    if (!currentQuote) return;
    setPrice(String(currentQuote));
    setPriceTouched(true);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (blocked) return;
    setSubmitting(true);
    try {
      const payload = {
        symbol,
        side,
        order_type: 'limit',
        amount: String(amount),
        price: String(price),
      };
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      notify(`${side === 'buy' ? 'Buy' : 'Sell'} ${result.status} · ${result.client_order_id}`, 'success');
      await loadAccount();
    } catch (error) {
      notify(error.message || 'Order could not be submitted', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const inr = portfolio?.balances?.find((item) => item.currency === 'INR');
  const baseBalance = portfolio?.balances?.find((item) => item.currency === base);

  return (
    <section className="panel ticket-panel">
      <div className="panel-head ticket-heading"><div><div className="eyebrow">ORDER TICKET</div><h2>Place an order</h2></div><span className="limit-tag">LIMIT ONLY <ChevronDown size={12} /></span></div>
      <div className="side-switch"><button className={side === 'buy' ? 'buy active' : 'buy'} onClick={() => setSide('buy')}>Buy <ArrowUpRight size={15} /></button><button className={side === 'sell' ? 'sell active' : 'sell'} onClick={() => setSide('sell')}>Sell <ArrowDownRight size={15} /></button></div>
      <div className="ticket-market"><span>MARKET</span><strong>{shortSymbol(symbol)}</strong><span className="market-live"><StatusDot state={quote ? 'online' : 'muted'} /> SPOT</span></div>
      <form onSubmit={submit} className="ticket-form">
        <label className="field-label" htmlFor="order-price">Limit price <span>INR</span></label>
        <div className="field-with-action"><input id="order-price" type="number" inputMode="decimal" min="0" step="any" value={price} onChange={(event) => { setPrice(event.target.value); setPriceTouched(true); }} placeholder="Live quote unavailable" required /><button type="button" onClick={fillFromMarket} disabled={!currentQuote}>{side === 'buy' ? 'ASK' : 'BID'}</button></div>
        <label className="field-label" htmlFor="order-amount">Amount <span>{base}</span></label>
        <div className="field-with-action"><input id="order-amount" type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00000000" required /><span className="field-unit">{base}</span></div>
        <div className="size-shortcuts"><button type="button" onClick={() => setAmount('0.0001')}>0.0001</button><button type="button" onClick={() => setAmount('0.0005')}>0.0005</button><button type="button" onClick={() => setAmount('0.001')}>0.001</button><span>MINIMUM SIZE APPLIES</span></div>
        <div className="ticket-summary"><span>Estimated total</span><strong>{money(total)}</strong></div>
        {side === 'buy' ? <div className="available-row"><span>Free INR</span><strong>{inr ? money(inr.free) : mode === 'live' && !authenticated ? 'Sign in to view' : '—'}</strong></div> : <div className="available-row"><span>Desk-tracked {base}</span><strong>{baseBalance ? quantity(baseBalance.free) : '—'} {base}</strong></div>}
        {mode === 'live' && <div className="inline-alert"><AlertTriangle size={14} /> Live ZebPay order placement is disabled while the official order contract remains unresolved. No live request will be sent.</div>}
        <button className={`submit-order ${side}`} type="submit" disabled={blocked || submitting}>
          {submitting ? <LoaderCircle className="spin" size={17} /> : side === 'buy' ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
          {submitting ? 'Submitting…' : mode === 'live' ? 'Live order routing disabled' : `Place ${side} limit order`}
        </button>
      </form>
      <div className="ticket-safety"><ShieldCheck size={14} /><span>Paper orders are simulated locally. Live order placement is disabled; no balance, order or fill is fabricated.</span></div>
    </section>
  );
}

function AuthBanner() {
  const mode = useTerminalStore((state) => state.mode);
  const health = useTerminalStore((state) => state.health);
  const authenticated = useTerminalStore((state) => state.authenticated);
  const authReady = Boolean(health?.operator_auth_ready);
  const liveWritesSupported = health?.live_order_routing_supported === true;
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  if (mode === 'paper' && !authReady) return null;

  const login = async (event) => {
    event.preventDefault();
    if (!authReady || !password) return;
    setLoading(true);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      useTerminalStore.getState().set({ authenticated: true });
      setPassword('');
      setShowPassword(false);
      notify('Operator session unlocked. ZebPay live order writes remain disabled.', 'success');
      await loadAccount();
    } catch (error) {
      notify(error.message || 'Sign in failed', 'error');
    } finally {
      setLoading(false);
    }
  };
  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* Session cookie may already be expired. */ }
    useTerminalStore.getState().set({ authenticated: false, portfolio: null, orders: [], positions: [], journal: [] });
    notify('Operator session locked');
  };

  return (
    <section className={`auth-banner ${authenticated ? 'unlocked' : ''}`}>
      <div className="auth-icon">{authReady ? <LockKeyhole size={18} /> : <AlertTriangle size={18} />}</div>
      <div className="auth-copy">
        <strong>{!authReady ? 'Finish secure operator setup' : authenticated ? 'Operator session unlocked' : 'Sign in to account & settings'}</strong>
        <span>
          {!authReady
            ? 'Open Settings to complete first-run setup. Secure operator access protects private account reads and credential changes.'
            : mode === 'paper'
              ? authenticated
                ? 'Operator session is active for secure settings. Paper orders remain simulated locally.'
                : 'Sign in to change exchange/security settings. Paper orders remain simulated locally.'
              : !liveWritesSupported
                ? authenticated
                  ? 'Session active for private account reads and credential management. Live order placement and cancellation are disabled.'
                  : 'Sign in for private account access. Live order placement and cancellation are disabled.'
                : authenticated
                  ? 'Private account access is unlocked.'
                  : 'Sign in to view private balances.'}
        </span>
      </div>
      {!authReady
        ? <span className="auth-state locked">SETUP IN SETTINGS</span>
        : mode === 'live' && !liveWritesSupported && <span className="auth-state locked">LIVE WRITES DISABLED</span>}
      {!authReady ? null : authenticated ? (
        <button className="button ghost-button" onClick={logout}><LogOut size={15} /> Lock desk</button>
      ) : (
        <form className="login-form" onSubmit={login}>
          <div className="login-input">
            <KeyRound size={15} aria-hidden="true" />
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              aria-label="Operator password"
              placeholder="Operator password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              className="password-toggle"
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <button className="button amber-button" type="submit" disabled={loading || !authReady || !password}>
            {loading ? <LoaderCircle className="spin" size={15} /> : 'Unlock desk'}
            <ArrowUpRight size={14} />
          </button>
        </form>
      )}
    </section>
  );
}

function SecretField({ label, value, onChange, placeholder, help, autoComplete = 'off', required = false, minLength, maxLength = 512 }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="settings-field">
      <span className="settings-field-label">{label}</span>
      <span className="settings-input-shell">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          aria-label={label}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
        />
        <button
          type="button"
          className="settings-secret-toggle"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={visible}
          title={visible ? 'Hide value' : 'Show value'}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </span>
      {help && <small className="settings-field-help">{help}</small>}
    </div>
  );
}

function SettingsStatus({ label, ready, detail }) {
  return (
    <div className={`settings-status-item ${ready ? 'ready' : 'pending'}`}>
      <StatusDot state={ready ? 'online' : 'danger'} />
      <div><strong>{label}</strong><span>{detail}</span></div>
      <b>{ready ? 'READY' : 'NEEDS ACTION'}</b>
    </div>
  );
}

function SettingsPanel() {
  const health = useTerminalStore((state) => state.health);
  const serverConfig = useTerminalStore((state) => state.serverConfig);
  const setupInfo = useTerminalStore((state) => state.setupInfo);
  const authenticated = useTerminalStore((state) => state.authenticated);
  const selectedSymbol = useTerminalStore((state) => state.symbol);
  const authReady = Boolean(health?.operator_auth_ready ?? serverConfig?.operator_auth_ready);
  const secureCookieConfigured = Boolean(health?.secure_cookie_configured ?? serverConfig?.secure_cookie_configured);
  const liveConfigured = Boolean(health?.live_trading_configured ?? serverConfig?.live_trading_configured);
  const credentialsConfigured = Boolean(health?.credentials_configured ?? serverConfig?.credentials_configured);
  const allowedSymbols = health?.allowed_symbols || serverConfig?.allowed_symbols || ['BTC/INR', 'ETH/INR'];
  const risk = serverConfig?.risk || health?.risk || {};
  const setupCodeFile = setupInfo?.bootstrap_code_file || 'data/initial-setup.token';

  const [setupToken, setSetupToken] = useState('');
  const [bootstrapKey, setBootstrapKey] = useState('');
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [bootstrapPassword, setBootstrapPassword] = useState('');
  const [bootstrapConfirmation, setBootstrapConfirmation] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState('');
  const [liveBusy, setLiveBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  const refreshStatus = async () => {
    const [healthResult, configResult, sessionResult] = await Promise.allSettled([
      api('/api/health'), api('/api/config'), api('/api/auth/session'),
    ]);
    const patch = {};
    if (healthResult.status === 'fulfilled') patch.health = healthResult.value;
    if (configResult.status === 'fulfilled') {
      patch.serverConfig = configResult.value.server;
      patch.setupInfo = configResult.value.setup;
    }
    if (sessionResult.status === 'fulfilled') {
      patch.authenticated = Boolean(sessionResult.value.authenticated);
    }
    useTerminalStore.getState().set(patch);
  };

  const setupOperator = async (event) => {
    event.preventDefault();
    if (bootstrapPassword.length < 12 || bootstrapPassword !== bootstrapConfirmation) {
      notify('Use a 12+ character operator password and enter it the same way twice.', 'error');
      return;
    }
    setSetupBusy(true);
    try {
      const result = await api('/api/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          setup_token: setupToken,
          api_key: bootstrapKey,
          api_secret: bootstrapSecret,
          app_password: bootstrapPassword,
          password_confirmation: bootstrapConfirmation,
        }),
      });
      const state = useTerminalStore.getState();
      state.set({
        authenticated: Boolean(result.authenticated),
        health: { ...state.health, ...result.server, operator_authenticated: Boolean(result.authenticated) },
        serverConfig: result.server,
      });
      setSetupToken('');
      setBootstrapKey('');
      setBootstrapSecret('');
      setBootstrapPassword('');
      setBootstrapConfirmation('');
      notify('Secure setup saved. ZebPay live order writes remain disabled.', 'success');
      await refreshStatus();
    } catch (error) {
      notify(error.message || 'Secure setup failed', 'error');
    } finally {
      setSetupBusy(false);
    }
  };

  const saveCredentials = async (event) => {
    event.preventDefault();
    if (!apiKey || !apiSecret) {
      notify('Enter both the ZebPay API key and secret key.', 'error');
      return;
    }
    setCredentialBusy(true);
    try {
      await api('/api/settings/credentials', {
        method: 'POST',
        body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }),
      });
      setApiKey('');
      setApiSecret('');
      setTestResult(null);
      setTestError('');
      await refreshStatus();
      notify('ZebPay credentials saved on the server. Test read-only account access; live writes stay disabled.', 'success');
    } catch (error) {
      notify(error.message || 'Credentials could not be saved', 'error');
    } finally {
      setCredentialBusy(false);
    }
  };

  const runConnectionTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    setTestError('');
    try {
      const symbol = allowedSymbols.includes(selectedSymbol) ? selectedSymbol : allowedSymbols[0];
      const result = await api('/api/settings/test-connection', {
        method: 'POST',
        body: JSON.stringify({ symbol }),
      });
      setTestResult(result);
      if (result.ok) notify('ZebPay public market and signed account reads both passed. No order was sent.', 'success');
      else notify('ZebPay read-only connection test did not pass.', 'warning');
    } catch (error) {
      setTestError(error.message || 'Connection test failed');
      notify(error.message || 'Connection test failed', 'error');
    } finally {
      setTestBusy(false);
    }
  };

  const changeOperatorPassword = async (event) => {
    event.preventDefault();
    if (newPassword.length < 12 || newPassword !== newPasswordConfirmation) {
      notify('Choose a 12+ character password and confirm it exactly.', 'error');
      return;
    }
    setPasswordBusy(true);
    try {
      const result = await api('/api/settings/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          password_confirmation: newPasswordConfirmation,
        }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setNewPasswordConfirmation('');
      useTerminalStore.getState().set({ authenticated: Boolean(result.authenticated), serverConfig: result.server });
      await refreshStatus();
      notify('Operator password rotated. Other sessions have been invalidated.', 'success');
    } catch (error) {
      notify(error.message || 'Operator password could not be changed', 'error');
    } finally {
      setPasswordBusy(false);
    }
  };

  const disarmLegacyLiveFlag = async () => {
    setLiveBusy(true);
    try {
      await api('/api/settings/live-arm', {
        method: 'POST',
        body: JSON.stringify({ armed: false }),
      });
      await refreshStatus();
      notify('Live-trading configuration cleared. Live order routing remains unavailable.', 'success');
    } catch (error) {
      notify(error.message || 'Live-trading setting could not be cleared', 'error');
    } finally {
      setLiveBusy(false);
    }
  };

  return (
    <section id="settings" className="settings-section">
      <div className="settings-heading">
        <div>
          <div className="eyebrow">CONNECTIONS · SECURITY · EXECUTION</div>
          <h2>Exchange &amp; account settings</h2>
          <p>Manage ZebPay access safely, validate the real API connection and review the server-enforced limits.</p>
        </div>
        <a className="button ghost-button settings-doc-link" href="https://apidocs.zebpay.com/" target="_blank" rel="noreferrer">
          ZebPay API docs <ExternalLink size={13} />
        </a>
      </div>

      <div className="settings-status-grid">
        <SettingsStatus label="ZebPay keys" ready={credentialsConfigured} detail={credentialsConfigured ? 'Present on server; values are never returned' : 'API key and secret are not configured'} />
        <SettingsStatus label="Operator access" ready={authReady} detail={authReady ? 'Password, JWT session and secure cookie configured' : 'Complete one-time setup below'} />
        <SettingsStatus label="Spot API connection" ready={Boolean(testResult?.ok)} detail={testResult ? (testResult.ok ? 'Public and signed private reads passed' : 'Most recent connection test failed') : 'Run a read-only connection test'} />
        <SettingsStatus label="Real orders" ready={false} detail="Disabled: ZebPay's official order and cancel contracts conflict; no live write route is enabled" />
      </div>

      {!authReady ? (
        <div className="panel settings-card setup-card">
          <div className="settings-card-head"><div><span className="settings-step">FIRST-RUN SETUP</span><h3>Secure the terminal and connect ZebPay</h3></div><span className="settings-badge locked">SETUP REQUIRED</span></div>
          <p className="settings-explainer">The setup code is generated locally and consumed once. This form sends credentials only to this server over HTTPS (or localhost); secrets are stored in the server's private data directory and never sent back to the browser.</p>
          <div className="setup-token-note"><ShieldCheck size={16} /><span>Open the one-time setup code file on the server: <code>{setupCodeFile}</code>. Do not paste the code or API credentials into chat.</span></div>
          <form className="settings-form" onSubmit={setupOperator}>
            <div className="settings-form-grid">
              <SecretField label="One-time setup code" value={setupToken} onChange={setSetupToken} placeholder="Paste local setup code" required />
              <SecretField label="ZebPay API key" value={bootstrapKey} onChange={setBootstrapKey} placeholder="Spot API key" required help="If scopes are offered, grant trade:read, trade:create and spot:trading; add wallet:transactions:read only if required for balances. Never enable wallet sends, address creation or Futures." />
              <SecretField label="ZebPay secret key" value={bootstrapSecret} onChange={setBootstrapSecret} placeholder="Spot API secret" required />
              <SecretField label="New operator password" value={bootstrapPassword} onChange={setBootstrapPassword} placeholder="At least 12 characters" autoComplete="new-password" required minLength={12} />
              <SecretField label="Confirm operator password" value={bootstrapConfirmation} onChange={setBootstrapConfirmation} placeholder="Re-enter operator password" autoComplete="new-password" required minLength={12} />
            </div>
            <div className="settings-inline-note"><LockKeyhole size={14} /><span>The server creates its own long JWT signing secret and enables secure cookies. Live order entry and cancellation remain disabled.</span></div>
            <button className="button amber-button" type="submit" disabled={setupBusy || !setupToken || !bootstrapKey || !bootstrapSecret || bootstrapPassword.length < 12 || bootstrapPassword !== bootstrapConfirmation}>
              {setupBusy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              {setupBusy ? 'Saving secure setup…' : 'Save setup & unlock settings'}
            </button>
          </form>
        </div>
      ) : !authenticated ? (
        <div className="panel settings-card settings-locked-card">
          <LockKeyhole size={19} />
          <div><h3>Sign in to manage settings</h3><p>Use the operator password above to rotate ZebPay keys, test authenticated account access, or change the password. Live order routing is disabled.</p></div>
        </div>
      ) : (
        <div className="settings-grid">
          <div className="panel settings-card">
            <div className="settings-card-head"><div><span className="settings-step">EXCHANGE API</span><h3>API credentials</h3></div><span className={`settings-badge ${credentialsConfigured ? 'ready' : 'locked'}`}>{credentialsConfigured ? 'CONFIGURED' : 'MISSING'}</span></div>
            <p className="settings-explainer">Keys are held by the FastAPI server. They are never prefetched into this page or returned by the API. Leave no values saved in browser storage.</p>
            <form className="settings-form" onSubmit={saveCredentials}>
              <SecretField label="New ZebPay API key" value={apiKey} onChange={setApiKey} placeholder="Enter or rotate Spot API key" required />
              <SecretField label="New ZebPay secret key" value={apiSecret} onChange={setApiSecret} placeholder="Enter or rotate Spot API secret" required />
              <div className="settings-inline-note"><ShieldCheck size={14} /><span>If scopes are offered: trade:read, trade:create and spot:trading; wallet:transactions:read only if required for balance reads. Never grant sends, address creation or Futures.</span></div>
              <button className="button amber-button" type="submit" disabled={credentialBusy || !apiKey || !apiSecret}>
                {credentialBusy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}
                {credentialBusy ? 'Saving keys…' : 'Save / rotate keys'}
              </button>
            </form>
            <div className="settings-docs-row"><a href="https://github.com/zebpay/zebpay-api-references/tree/main/spot/api-reference" target="_blank" rel="noreferrer">Official Spot API reference <ExternalLink size={12} /></a><span>API-key HMAC signing is server-side; OAuth callback URLs are not used.</span></div>
          </div>

          <div className="panel settings-card">
            <div className="settings-card-head"><div><span className="settings-step">READ-ONLY CHECK</span><h3>Test exchange connection</h3></div><span className={`settings-badge ${testResult?.ok ? 'ready' : 'locked'}`}>{testResult?.ok ? 'CONNECTED' : 'NOT VERIFIED'}</span></div>
            <p className="settings-explainer">Checks live ZebPay spot market data and makes an authenticated balance read. This test does not create, edit or cancel any orders.</p>
            <div className="connection-test-grid">
              <div className={testResult?.market_data?.ok ? 'connection-result good' : testResult ? 'connection-result bad' : 'connection-result'}>
                <span>Public market data</span><strong>{testResult?.market_data?.ok ? 'Connected' : testResult ? 'Unavailable' : 'Not tested'}</strong>
                {testResult?.market_data?.error && <small>{testResult.market_data.error}</small>}
              </div>
              <div className={testResult?.private_account?.ok ? 'connection-result good' : testResult ? 'connection-result bad' : 'connection-result'}>
                <span>Signed account read</span><strong>{testResult?.private_account?.ok ? `Verified · ${testResult.private_account.assets_returned ?? 0} assets` : testResult ? 'Failed' : 'Not tested'}</strong>
                {testResult?.private_account?.error && <small>{testResult.private_account.error}</small>}
              </div>
            </div>
            {testError && <div className="connection-error">{testError}</div>}
            <button className="button ghost-button" type="button" onClick={runConnectionTest} disabled={testBusy || !credentialsConfigured}>
              {testBusy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              {testBusy ? 'Checking ZebPay…' : 'Test API connection'}
            </button>
            <small className="settings-footnote">Last check: {testResult?.tested_at ? new Date(testResult.tested_at).toLocaleString() : 'Not tested in this session'} · Orders submitted by check: {testResult?.orders_submitted ?? 0}</small>
          </div>

          <div className="panel settings-card settings-live-card">
            <div className="settings-card-head"><div><span className="settings-step">LIVE EXECUTION STATUS</span><h3>Real orders are disabled</h3></div><span className="settings-badge locked">NOT IMPLEMENTED</span></div>
            <p className="settings-explainer">Read-only ZebPay account access is separate from live order readiness. The current official reference and clients conflict on order fields and cancellation paths, so this app sends no live create or cancel requests.</p>
            <div className="settings-warning">Do not rely on an arming flag, connection check, or successful market read to authorize live orders. Place and manage exchange orders directly in ZebPay until its contract is clarified and independently verified.</div>
            {liveConfigured && <button className="button danger-button" type="button" onClick={disarmLegacyLiveFlag} disabled={liveBusy}>
              {liveBusy ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />}
              {liveBusy ? 'Clearing…' : 'Clear configured live flag'}
            </button>}
          </div>

          <div className="panel settings-card">
            <div className="settings-card-head"><div><span className="settings-step">OPERATOR SECURITY</span><h3>Change operator password</h3></div><span className="settings-badge ready">SERVER-SIDE</span></div>
            <form className="settings-form" onSubmit={changeOperatorPassword}>
              <SecretField label="Current operator password" value={currentPassword} onChange={setCurrentPassword} placeholder="Current password" autoComplete="current-password" required />
              <SecretField label="New operator password" value={newPassword} onChange={setNewPassword} placeholder="At least 12 characters" autoComplete="new-password" required minLength={12} />
              <SecretField label="Confirm new password" value={newPasswordConfirmation} onChange={setNewPasswordConfirmation} placeholder="Re-enter new password" autoComplete="new-password" required minLength={12} />
              <button className="button ghost-button" type="submit" disabled={passwordBusy || !currentPassword || newPassword.length < 12 || newPassword !== newPasswordConfirmation}>
                {passwordBusy ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />}
                {passwordBusy ? 'Updating password…' : 'Change password & rotate sessions'}
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="panel settings-card settings-risk-card">
        <div className="settings-card-head"><div><span className="settings-step">SERVER-ENFORCED LIMITS</span><h3>Risk &amp; market allowlist</h3></div><span className="settings-badge ready">READ ONLY</span></div>
        <div className="settings-risk-grid">
          <div><span>Allowed spot pairs</span><strong>{allowedSymbols.join(' · ') || '—'}</strong></div>
          <div><span>Maximum order</span><strong>{risk.max_order_notional ? money(risk.max_order_notional) : '—'}</strong></div>
          <div><span>Daily notional</span><strong>{risk.max_daily_notional ? money(risk.max_daily_notional) : '—'}</strong></div>
          <div><span>Open-order cap</span><strong>{risk.max_open_orders ?? '—'}</strong></div>
          <div><span>Minimum order</span><strong>{risk.minimum_notional ? money(risk.minimum_notional) : '—'}</strong></div>
          <div><span>Maximum price deviation</span><strong>{risk.max_price_deviation_pct ? `${Number(risk.max_price_deviation_pct) * 100}%` : '—'}</strong></div>
          <div><span>Daily loss stop</span><strong>{risk.max_daily_loss_quote ? money(risk.max_daily_loss_quote) : '—'}</strong></div>
          <div><span>Session cookie</span><strong>{secureCookieConfigured ? 'HTTPS secure' : 'Not configured'}</strong></div>
        </div>
        <p className="settings-footnote">The UI cannot increase these hard server limits. An unavailable ZebPay feed is never replaced with sample prices.</p>
      </div>
    </section>
  );
}

function ForecastPanel() {
  const forecast = useTerminalStore((state) => state.forecast);
  const [loading, setLoading] = useState(false);
  const symbol = useTerminalStore((state) => state.symbol);
  const run = async () => {
    setLoading(true);
    try {
      const data = await loadForecast();
      notify(`${data.source === 'kronos' ? 'Kronos' : 'EMA + momentum fallback'} forecast ready`, 'success');
    } catch (error) {
      notify(error.message || 'Forecast unavailable; confirm live candles are reachable', 'error');
    } finally {
      setLoading(false);
    }
  };
  const signal = forecast?.signal || '—';
  const direction = forecast?.expected_return;
  return (
    <section className="panel forecast-panel">
      <div className="panel-head compact-head"><div><div className="eyebrow">MODEL RESEARCH</div><h2>Kronos forecast</h2></div><span className="kronos-mark"><Sparkles size={15} /> K</span></div>
      <div className="forecast-summary">
        <div className={`signal-tile ${String(signal).toLowerCase()}`}><span>SIGNAL</span><strong>{signal}</strong><small>{forecast?.confidence !== undefined ? `${(Number(forecast.confidence) * 100).toFixed(0)}% confidence` : 'No forecast loaded'}</small></div>
        <div className="forecast-number"><span>PREDICTED CLOSE</span><strong>{forecast?.predicted_close ? money(forecast.predicted_close) : '—'}</strong><small>{forecast?.source === 'kronos' ? 'Kronos model' : forecast?.source === 'ema_momentum_fallback' ? 'EMA + momentum fallback' : 'Waiting for analysis'}</small></div>
      </div>
      <div className="forecast-details"><span>Expected return</span><strong className={direction === undefined ? 'muted-text' : positiveClass(direction)}>{direction === undefined ? '—' : `${Number(direction) >= 0 ? '+' : ''}${(Number(direction) * 100).toFixed(3)}%`}</strong><span>Forecast steps</span><strong>{forecast?.prediction_steps ?? '—'}</strong><span>Market</span><strong>{symbol}</strong></div>
      <button className="button forecast-button" onClick={run} disabled={loading}><Sparkles size={15} /> {loading ? 'Analyzing live candles…' : 'Analyze live candles'}{loading && <LoaderCircle className="spin" size={14} />}</button>
      <div className="forecast-disclaimer"><CircleHelp size={13} /> Forecasts can be wrong and never place orders by themselves.</div>
    </section>
  );
}

function StrategyPanel() {
  const strategy = useTerminalStore((state) => state.strategy);
  const runtime = useTerminalStore((state) => state.runtimeConfig);
  const health = useTerminalStore((state) => state.health);
  const symbols = health?.allowed_symbols || ['BTC/INR'];
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const running = strategy?.state === 'running';
  const mode = useTerminalStore((state) => state.mode);

  useEffect(() => {
    if (runtime) setDraft({
      symbol: runtime.trading.symbol,
      timeframe: runtime.trading.timeframe,
      order_size_base: runtime.trading.order_size_base,
      min_confidence: runtime.trading.min_confidence,
      loop_interval_sec: runtime.trading.loop_interval_sec,
      kronos_enabled: runtime.kronos.enabled,
      use_fallback: runtime.kronos.use_fallback,
    });
  }, [runtime]);

  const save = async () => {
    if (!runtime || !draft) return;
    setBusy(true);
    try {
      const config = structuredClone(runtime);
      config.trading.symbol = draft.symbol;
      config.trading.timeframe = draft.timeframe;
      config.trading.order_size_base = Number(draft.order_size_base);
      config.trading.min_confidence = Number(draft.min_confidence);
      config.trading.loop_interval_sec = Number(draft.loop_interval_sec);
      config.trading.enabled = false;
      config.kronos.enabled = Boolean(draft.kronos_enabled);
      config.kronos.use_fallback = Boolean(draft.use_fallback);
      const saved = await api('/api/strategy/config', { method: 'PUT', body: JSON.stringify(config) });
      useTerminalStore.getState().set({ runtimeConfig: saved });
      notify('Strategy configuration saved', 'success');
    } catch (error) {
      notify(error.message || 'Could not save strategy configuration', 'error');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const result = await api('/api/strategy/start', { method: 'POST', body: JSON.stringify({}) });
      useTerminalStore.getState().set({ strategy: result });
      notify('Autonomous strategy started', 'success');
    } catch (error) {
      notify(error.message || 'Strategy did not start', 'error');
    } finally {
      setBusy(false);
    }
  };
  const stop = async (path = '/api/strategy/stop') => {
    setBusy(true);
    try {
      const result = await api(path, { method: 'POST' });
      if (path.endsWith('emergency-stop')) {
        useTerminalStore.getState().set({ strategy: result.strategy });
        notify(`Strategy halted. ${result.canceled_order_ids?.length || 0} orders canceled; ${result.cancellation_failures?.length || 0} require manual review. Positions were not closed.`, 'warning');
      } else {
        useTerminalStore.getState().set({ strategy: result });
        notify('Strategy stopped', 'neutral');
      }
      await loadAccount();
    } catch (error) {
      notify(error.message || 'Strategy action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <section className="panel strategy-panel">
      <div className="panel-head compact-head"><div><div className="eyebrow">AUTONOMOUS STRATEGY</div><h2>Kronos Strategy</h2></div><span className={`strategy-state ${running ? 'running' : ''}`}><StatusDot state={running ? 'online' : 'muted'} /> {running ? 'RUNNING' : 'STOPPED'}</span></div>
      <div className="strategy-status-line"><span><Activity size={14} /> {strategy?.strategy?.last_action || 'Ready when explicitly started'}</span><span>{strategy?.tracked_orders ?? 0} tracked</span></div>
      {strategy?.last_error && <div className="inline-alert"><AlertTriangle size={14} /> {strategy.last_error}</div>}
      {draft && <div className="strategy-config-grid">
        <label>Market<select value={draft.symbol} onChange={(event) => updateDraft('symbol', event.target.value)}>{symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>
        <label>Timeframe<select value={draft.timeframe} onChange={(event) => updateDraft('timeframe', event.target.value)}>{TIMEFRAMES.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Order size<input type="number" min="0.00000001" step="any" value={draft.order_size_base} onChange={(event) => updateDraft('order_size_base', event.target.value)} /></label>
        <label>Min. confidence<input type="number" min="0" max="1" step="0.05" value={draft.min_confidence} onChange={(event) => updateDraft('min_confidence', event.target.value)} /></label>
        <label>Loop interval<input type="number" min="5" max="3600" step="1" value={draft.loop_interval_sec} onChange={(event) => updateDraft('loop_interval_sec', event.target.value)} /><small>seconds</small></label>
        <label className="toggle-field"><span>Kronos model</span><input type="checkbox" checked={draft.kronos_enabled} onChange={(event) => updateDraft('kronos_enabled', event.target.checked)} /></label>
        <label className="toggle-field"><span>Allow deterministic fallback</span><input type="checkbox" checked={draft.use_fallback} onChange={(event) => updateDraft('use_fallback', event.target.checked)} /></label>
      </div>}
      <div className="strategy-controls">
        <button className="button ghost-button" onClick={save} disabled={!draft || busy || running}><Check size={14} /> Save settings</button>
        {running ? <button className="button stop-button" onClick={() => stop()} disabled={busy}><Pause size={15} /> Stop strategy</button> : <button className="button start-button" onClick={start} disabled={busy || mode === 'live'}><Play size={15} /> {mode === 'live' ? 'Live automation disabled' : 'Start strategy'}</button>}
      </div>
      {mode === 'live' && <div className="inline-alert"><AlertTriangle size={14} /> Live strategy is disabled because ZebPay order entry and cancellation are not implemented.</div>}
      {mode === 'live' && <button className="emergency-button" disabled={busy} onClick={() => { if (window.confirm('Emergency stop halts the strategy. Automatic ZebPay order cancellation is disabled; manage any existing exchange orders directly in ZebPay. Positions will not be closed. Continue?')) stop('/api/strategy/emergency-stop'); }}><Square size={13} fill="currentColor" /> Emergency stop · strategy only</button>}
      <div className="strategy-footnote"><ShieldCheck size={13} /> Live automation cannot start until ZebPay order routing is confirmed and implemented.</div>
    </section>
  );
}

function OrdersPanel() {
  const orders = useTerminalStore((state) => state.orders);
  const mode = useTerminalStore((state) => state.mode);
  const [tab, setTab] = useState('orders');
  const cancel = async (order) => {
    if (!window.confirm(`Cancel ${order.client_order_id}?`)) return;
    try {
      const result = await api(`/api/orders/${encodeURIComponent(order.client_order_id)}?symbol=${encodeURIComponent(order.symbol)}`, { method: 'DELETE' });
      useTerminalStore.getState().updateOrder(result);
      await loadAccount();
      notify(`Order ${result.status}`, 'success');
    } catch (error) {
      notify(error.message || 'Cancel request failed', 'error');
    }
  };
  return (
    <section className="panel data-panel">
      <div className="panel-head"><div><div className="eyebrow">EXECUTION</div><h2>Orders &amp; positions</h2></div><div className="segmented"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Orders</button><button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>Positions</button></div></div>
      {tab === 'orders' ? <div className="table-scroll"><table><thead><tr><th>MARKET</th><th>SIDE</th><th>TYPE</th><th>PRICE</th><th>AMOUNT</th><th>FILLED</th><th>STATUS</th><th>TIME</th><th /></tr></thead><tbody>
        {orders.map((order) => <tr key={order.client_order_id}><td><strong>{order.symbol}</strong><small className="row-id">{order.client_order_id}</small></td><td><span className={`side-text ${order.side}`}>{order.side}</span></td><td>Limit</td><td>{money(order.price)}</td><td>{quantity(order.amount)}</td><td>{quantity(order.filled || 0)}</td><td><span className={`order-status ${String(order.status).replaceAll('_', '-')}`}>{String(order.status).replaceAll('_', ' ')}</span></td><td>{dateTime(order.created_at)}</td><td>{['open', 'partially_filled'].includes(order.status) && (mode === 'paper' ? <button className="table-action" onClick={() => cancel(order)}>Cancel</button> : <small className="muted-text">Manage in ZebPay</small>)}</td></tr>)}
        {!orders.length && <tr><td colSpan="9"><div className="empty-state"><ArrowDownRight size={18} /><strong>No {mode} orders yet</strong><span>Orders submitted from the ticket will appear here.</span></div></td></tr>}
      </tbody></table></div> : <PositionsTable />}
    </section>
  );
}

function PositionsTable() {
  const positions = useTerminalStore((state) => state.positions);
  return <div className="table-scroll"><table><thead><tr><th>MARKET</th><th>AMOUNT</th><th>AVG ENTRY</th><th>MARK PRICE</th><th>REALIZED P&amp;L</th><th>UNREALIZED P&amp;L</th><th>UPDATED</th></tr></thead><tbody>
    {positions.map((position) => <tr key={position.symbol}><td><strong>{position.symbol}</strong></td><td>{quantity(position.amount)} {position.base_currency}</td><td>{money(position.average_entry)}</td><td>{position.mark_price ? money(position.mark_price) : '—'}</td><td className={positiveClass(position.realized_pnl)}>{money(position.realized_pnl)}</td><td className={position.unrealized_pnl === null ? 'muted-text' : positiveClass(position.unrealized_pnl)}>{position.unrealized_pnl === null ? '—' : money(position.unrealized_pnl)}</td><td>{dateTime(position.updated_at)}</td></tr>)}
    {!positions.length && <tr><td colSpan="7"><div className="empty-state"><Wallet size={18} /><strong>No desk-tracked positions</strong><span>Positions appear after a fill has been recorded in this terminal.</span></div></td></tr>}
  </tbody></table></div>;
}

function JournalPanel() {
  const journal = useTerminalStore((state) => state.journal);
  const total = useTerminalStore((state) => state.journalTotal);
  return (
    <section className="panel data-panel journal-panel">
      <div className="panel-head"><div><div className="eyebrow">PERSISTENT LEDGER</div><h2>Execution journal</h2></div><span className="subtle">{total} recorded fills</span></div>
      <div className="table-scroll"><table><thead><tr><th>TIME</th><th>MARKET</th><th>SIDE</th><th>FILL PRICE</th><th>AMOUNT</th><th>FEE</th><th>REALIZED P&amp;L</th></tr></thead><tbody>
        {journal.map((trade) => <tr key={trade.trade_id}><td>{dateTime(trade.created_at)}</td><td><strong>{trade.symbol}</strong></td><td><span className={`side-text ${trade.side}`}>{trade.side}</span></td><td>{money(trade.price)}</td><td>{quantity(trade.amount)}</td><td>{quantity(trade.fee, 6)} {trade.fee_currency || ''}</td><td className={positiveClass(trade.realized_pnl)}>{money(trade.realized_pnl)}</td></tr>)}
        {!journal.length && <tr><td colSpan="7"><div className="empty-state"><Landmark size={18} /><strong>No fills recorded</strong><span>Submitted orders are not fills; this journal updates only from confirmed executions.</span></div></td></tr>}
      </tbody></table></div>
    </section>
  );
}

function RiskPanel() {
  const risk = useTerminalStore((state) => state.risk);
  const status = risk?.state;
  const limits = status?.limits || {};
  const events = risk?.recent_events || [];
  const resume = async () => {
    try {
      const result = await api('/api/risk/resume', { method: 'POST' });
      useTerminalStore.getState().set({ risk: { ...risk, state: result } });
      notify('Risk circuit resumed. Confirm current balances and exposure before enabling execution.', 'warning');
    } catch (error) { notify(error.message || 'Could not resume risk engine', 'error'); }
  };
  return (
    <section id="risk" className="panel risk-panel">
      <div className="panel-head compact-head"><div><div className="eyebrow">GUARDRAILS</div><h2>Risk controls</h2></div><span className={`risk-badge ${status?.halted ? 'halted' : ''}`}><StatusDot state={status?.halted ? 'danger' : 'online'} /> {status?.halted ? 'HALTED' : 'ACTIVE'}</span></div>
      {status?.halted && <div className="risk-halt-message"><AlertTriangle size={15} /><span>{status.halt_reason || 'Trading is halted by the risk circuit.'}</span></div>}
      <div className="risk-grid">
        <div><span>Daily realized P&amp;L</span><strong className={positiveClass(status?.daily_realized_pnl)}>{money(status?.daily_realized_pnl)}</strong></div>
        <div><span>Daily fills</span><strong>{status?.daily_trades ?? '—'} / {limits.max_daily_trades ?? '—'}</strong></div>
        <div><span>Order notional cap</span><strong>{limits.max_order_notional_quote ? money(limits.max_order_notional_quote) : '—'}</strong></div>
        <div><span>Position cap</span><strong>{limits.max_position_base ? `${quantity(limits.max_position_base)} base` : '—'}</strong></div>
        <div><span>Loss cooldown</span><strong>{status?.cooldown_remaining_seconds ? `${status.cooldown_remaining_seconds}s` : 'Clear'}</strong></div>
        <div><span>Daily notional cap</span><strong>{limits.max_daily_notional_quote ? money(limits.max_daily_notional_quote) : '—'}</strong></div>
      </div>
      {status?.halted && <button className="button resume-button" onClick={resume}><Check size={14} /> Resume risk circuit</button>}
      <div className="risk-events-title">RECENT RISK EVENTS</div>
      <div className="risk-events-list">{events.slice(0, 4).map((event) => <div key={event.id}><span className="risk-event-dot" /><span><strong>{event.event_type.replaceAll('_', ' ')}</strong><small>{event.reason}</small></span><time>{dateTime(event.created_at)}</time></div>)}{!events.length && <span className="empty-mini">No risk events recorded.</span>}</div>
    </section>
  );
}

function Toast() {
  const toast = useTerminalStore((state) => state.toast);
  const clear = useTerminalStore((state) => state.setToast);
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' || toast.tone === 'warning' ? <AlertTriangle size={15} /> : <Bell size={15} />}</span><span>{toast.message}</span><button onClick={() => clear(null)} aria-label="Dismiss notification"><X size={15} /></button></div>;
}

function App() {
  const mode = useTerminalStore((state) => state.mode);
  const health = useTerminalStore((state) => state.health);
  const symbol = useTerminalStore((state) => state.symbol);
  const timeframe = useTerminalStore((state) => state.timeframe);
  const wsState = useTerminalStore((state) => state.wsState);
  const feedState = useTerminalStore((state) => state.feedState);
  const portfolio = useTerminalStore((state) => state.portfolio);
  const quotes = useTerminalStore((state) => state.quotes);
  const [refreshing, setRefreshing] = useState(false);
  const allowedSymbols = health?.allowed_symbols?.length ? health.allowed_symbols : ['BTC/INR', 'ETH/INR'];
  const activeQuote = quotes[symbol];
  const inr = portfolio?.balances?.find((item) => item.currency === 'INR');
  const maxDaily = Number(health?.risk?.max_daily_notional || 0);
  const usedDaily = Number(portfolio?.daily_notional || 0);
  const dailyPercent = maxDaily ? Math.min(100, (usedDaily / maxDaily) * 100) : 0;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadPair(symbol, timeframe);
      await loadAccount();
      notify('Terminal refreshed', 'success');
    } catch (error) {
      notify(error.message || 'ZebPay market data is unavailable', 'error');
    } finally {
      setRefreshing(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    let alive = true;
    const bootstrap = async () => {
      const [healthResult, configResult, sessionResult] = await Promise.allSettled([
        api('/api/health'), api('/api/config'), api('/api/auth/session'),
      ]);
      if (!alive) return;
      const patch = {};
      if (healthResult.status === 'fulfilled') {
        patch.health = healthResult.value;
        patch.mode = healthResult.value.mode || 'paper';
        patch.authenticated = Boolean(healthResult.value.operator_authenticated);
      }
      if (configResult.status === 'fulfilled') {
        patch.serverConfig = configResult.value.server;
        patch.setupInfo = configResult.value.setup;
        patch.runtimeConfig = configResult.value.runtime;
      }
      if (sessionResult.status === 'fulfilled') {
        patch.authenticated = Boolean(sessionResult.value.authenticated);
        patch.mode = sessionResult.value.mode || patch.mode || 'paper';
      }
      useTerminalStore.getState().set(patch);
      const current = useTerminalStore.getState();
      if (healthResult.status === 'rejected') {
        useTerminalStore.getState().set({ feedState: 'unavailable' });
        notify('Backend is not reachable. Start the FastAPI service and refresh.', 'error');
      }
      try { await loadPair(current.symbol, current.timeframe); }
      catch { /* The page remains useful while the exchange is offline; no synthetic feed is generated. */ }
      await loadAccount();
      try {
        const saved = await api('/api/strategy/config');
        useTerminalStore.getState().set({ runtimeConfig: saved });
      } catch { /* Runtime strategy settings are private in live mode until sign-in. */ }
    };
    bootstrap();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let socket;
    let retryTimer;
    let delay = 1000;
    const connect = () => {
      if (!active) return;
      useTerminalStore.getState().set({ wsState: 'connecting' });
      socket = new WebSocket(wsUrl());
      socket.onopen = () => {
        delay = 1000;
        useTerminalStore.getState().set({ wsState: 'connected' });
      };
      socket.onmessage = (message) => {
        let event;
        try { event = JSON.parse(message.data); } catch { return; }
        const state = useTerminalStore.getState();
        const data = event.data;
        if (event.type === 'market_update' && data?.symbol) state.setQuote(data);
        if (event.type === 'feed_status') state.set({ feedState: data.connected ? 'connected' : 'unavailable' });
        if (event.type === 'feed_error') state.set({ feedState: 'unavailable' });
        if (event.type === 'orders_snapshot' && Array.isArray(data)) state.set({ orders: data });
        if (event.type === 'order_update' && data?.client_order_id) state.updateOrder(data);
        if (event.type.startsWith('on_order_') && data?.order) state.updateOrder({
          client_order_id: data.order.client_order_id,
          exchange_order_id: data.order.exchange_order_id,
          symbol: data.order.trading_pair,
          side: data.order.trade_type?.toLowerCase(),
          order_type: data.order.order_type?.toLowerCase(),
          amount: data.order.amount,
          price: data.order.price,
          filled: data.order.filled_amount,
          status: data.order.state?.toLowerCase(),
          created_at: data.order.created_at ? new Date(data.order.created_at * 1000).toISOString() : null,
        });
        if (event.type === 'strategy_status') state.set({ strategy: data });
        if (event.type === 'risk_status') state.set({ risk: { ...state.risk, state: data } });
        if (event.type === 'forecast_update') state.set({ forecast: data });
        if (event.type === 'position_update' || event.type === 'operator_status') loadAccount();
        if (event.type === 'config_update') state.set({ runtimeConfig: data });
        if (event.type === 'settings_update') state.set({ serverConfig: data, health: { ...state.health, ...data } });
      };
      socket.onclose = (event) => {
        if (!active) return;
        useTerminalStore.getState().set({ wsState: event.code === 4401 ? 'locked' : 'disconnected' });
        if (event.code === 4401) {
          useTerminalStore.getState().set({ authenticated: false, portfolio: null });
          notify('Operator session expired. Sign in again to resume private access.', 'warning');
        }
        retryTimer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
      socket.onerror = () => { socket?.close(); };
    };
    connect();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    loadPair(symbol, timeframe).catch((error) => {
      if (alive) useTerminalStore.getState().set({ feedState: 'unavailable' });
    });
    return () => { alive = false; };
  }, [symbol, timeframe]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadAccount();
      loadPair(useTerminalStore.getState().symbol, useTerminalStore.getState().timeframe).catch(() => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const portfolioEquity = portfolio?.equity_inr;
  const dayPnl = portfolio?.day_pnl_inr;
  const openCount = portfolio?.open_orders;
  const change = Number(activeQuote?.percentage);

  return (
    <div className="terminal-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ZebPay Kronos Terminal home"><span className="brand-symbol">Z</span><span className="brand-text"><strong>ZEPAY</strong><small>KRONOS TERMINAL</small></span></a>
        <nav className="main-nav"><a className="current" href="#overview">Overview</a><a href="#markets">Markets</a><a href="#strategy">Strategy</a><a href="#orders">Orders</a><a href="#risk">Risk</a><a href="#settings">Settings</a></nav>
        <div className="topbar-right"><div className="connection-pill"><StatusDot state={wsState === 'connected' ? 'online' : wsState === 'connecting' ? 'connecting' : 'muted'} /><span>{wsState === 'connected' ? 'TERMINAL EVENT STREAM' : wsState === 'connecting' ? 'EVENT STREAM CONNECTING' : 'EVENT STREAM OFFLINE'}</span></div><div className={`mode-pill ${mode}`}><i />{mode === 'live' ? 'LIVE · READ ONLY' : 'PAPER'}</div><button className="icon-ghost refresh-button" onClick={refresh} title="Refresh terminal" disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button><button className="profile-button" title="Exchange and account settings" aria-label="Open exchange and account settings" onClick={() => document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={15} /></button></div>
      </header>

      <main id="top" className="page-wrap">
        <section id="overview" className="hero-row">
          <div><div className="hero-kicker"><span /> SPOT MARKETS <b>·</b> INDIA</div><h1>Trading terminal<span>.</span></h1><p>Real ZebPay market data. Paper-first workflow. Live order writes remain disabled until the official contract is clear.</p></div>
          <div className="hero-right"><div className={`feed-status ${feedState}`}><StatusDot state={feedState === 'connected' ? 'online' : feedState === 'connecting' ? 'connecting' : 'danger'} /><span>{feedState === 'connected' ? 'ZEBPAY DATA CONNECTED' : feedState === 'connecting' ? 'CONNECTING TO ZEBPAY' : 'MARKET DATA UNAVAILABLE'}</span></div><small>Updated {clock(useTerminalStore.getState().lastUpdate)}</small></div>
        </section>

        <AuthBanner />

        <section className="safety-banner"><div className="safety-icon"><ShieldCheck size={16} /></div><div><strong>{mode === 'paper' ? 'Paper trading is active' : 'Live order writes are disabled'}</strong><span>{mode === 'paper' ? 'Orders are simulated locally against real ZebPay bid/ask quotes. If the exchange is unavailable, no substitute price or candle data is generated.' : 'ZebPay order placement and cancellation are fail-closed because official sources conflict. Use ZebPay directly to manage real exchange orders.'}</span></div><span className="safety-right"><StatusDot state="online" /> NO SAMPLE MARKET DATA</span></section>

        <section className="metrics-grid" aria-label="Account overview">
          <MetricCard label="ESTIMATED EQUITY" value={portfolioEquity === null || portfolioEquity === undefined ? '—' : money(portfolioEquity, true)} detail={portfolio?.equity_complete === false ? 'Partial valuation · missing market mark' : 'Marked to market in INR'} icon={Wallet} tag={portfolio?.equity_complete === false ? 'PARTIAL' : 'INR VALUE'} />
          <MetricCard label="TODAY REALIZED P&L" value={dayPnl === null || dayPnl === undefined ? '—' : money(dayPnl)} detail="Confirmed fills recorded by this desk" icon={Number(dayPnl) >= 0 ? TrendingUp : TrendingDown} tone={dayPnl === null ? 'normal' : Number(dayPnl) >= 0 ? 'positive-card' : 'negative-card'} tag="JOURNAL ONLY" />
          <MetricCard label="FREE INR" value={inr ? money(inr.free, true) : '—'} detail={mode === 'live' && !useTerminalStore.getState().authenticated ? 'Unlock private account data' : 'Available quote currency'} icon={Landmark} tag="SPOT WALLET" />
          <MetricCard label="OPEN ORDERS" value={openCount ?? '—'} detail="App-tracked orders · all selected pairs" icon={Activity} tag={maxDaily ? `${dailyPercent.toFixed(0)}% DAILY CAP` : 'ORDER LEDGER'} />
        </section>

        <section id="markets" className="market-section">
          <Watchlist symbols={allowedSymbols} />
          <div className="market-layout">
            <div className="market-main-column"><ChartPanel /><BookPanel /></div>
            <aside className="market-side-column"><OrderTicket /><ForecastPanel /></aside>
          </div>
        </section>

        <section id="strategy" className="strategy-layout"><StrategyPanel /><RiskPanel /></section>

        <section id="orders" className="data-stack"><OrdersPanel /><JournalPanel /></section>

        <SettingsPanel />

        <footer className="footer"><div><span className="brand-symbol small">Z</span><span>ZEBA​YP KRONOS TERMINAL</span><b>·</b><span>BUILD 0.2.0</span></div><div><span><StatusDot state={feedState === 'connected' ? 'online' : 'muted'} /> {feedState === 'connected' ? 'ZEBPAY PUBLIC REST' : 'EXCHANGE FEED OFFLINE'}</span><span>Market data, fills and execution state may be delayed.</span><a href="/api/docs" target="_blank" rel="noreferrer">API docs <ExternalLink size={12} /></a></div></footer>
      </main>
      <Toast />
    </div>
  );
}

export default App;
