(() => {
  const LIVE_CONFIRMATION = "I UNDERSTAND THIS IS A LIVE ORDER";
  const state = {
    symbol: "BTC/INR",
    timeframe: "5m",
    side: "buy",
    mode: "paper",
    liveReady: false,
    authenticated: false,
    market: null,
    candles: [],
    config: null,
    refreshTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const amountFormatter = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 8 });
  const inrFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw || "Unexpected server response" }; }
    if (!response.ok) {
      const message = data.error || data.detail || `Request failed (${response.status})`;
      const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  function money(value, currency = "INR") {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return currency === "INR" ? inrFormatter.format(number) : `${amountFormatter.format(number)} ${currency}`;
  }

  function compactMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number >= 1e7) return `₹${(number / 1e7).toFixed(2)} Cr`;
    if (number >= 1e5) return `₹${(number / 1e5).toFixed(2)} L`;
    return money(number);
  }

  function toast(message, isError = false) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.toggle("error", isError);
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 3600);
  }

  function setMode(health) {
    state.mode = health.mode || "paper";
    state.liveReady = !!health.live_ready;
    state.authenticated = !!health.operator_authenticated;
    const pill = $("#modePill");
    pill.classList.toggle("live", state.mode === "live");
    $("#modeText").textContent = state.mode === "live" ? "LIVE MODE" : "PAPER MODE";
    $("#paperNotice").classList.toggle("hidden", state.mode !== "paper");
    updateLivePanel();
    updateOrderButton();
  }

  function updateLivePanel() {
    const panel = $("#liveAuthPanel");
    const form = $("#loginForm");
    const liveConfirm = $("#liveConfirmRow");
    const logoutButton = $("#logoutButton");
    if (state.mode !== "live") {
      panel.classList.add("hidden");
      liveConfirm.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    liveConfirm.classList.remove("hidden");
    if (!state.liveReady) {
      form.classList.add("hidden");
      logoutButton.classList.add("hidden");
      $(".live-copy strong").textContent = "Live mode is locked";
      $(".live-copy span").textContent = "Configure server-side API keys, a strong operator password, live-trading gates, and secure cookies, then restart the service.";
    } else if (state.authenticated) {
      form.classList.add("hidden");
      logoutButton.classList.remove("hidden");
      $(".live-copy strong").textContent = "Operator session unlocked";
      $(".live-copy span").textContent = "Private balance and live order actions are available. Each order still requires explicit confirmation.";
    } else {
      form.classList.remove("hidden");
      logoutButton.classList.add("hidden");
      $(".live-copy strong").textContent = "Live mode is server-armed";
      $(".live-copy span").textContent = "Authenticate to view private balances and submit real ZebPay limit orders.";
    }
  }

  function updateConnection(quote) {
    const provider = quote?.source || "offline";
    const simulated = quote?.is_simulated || provider === "simulated";
    $("#providerLabel").textContent = simulated ? "SIMULATED FEED" : "ZEBPAY PUBLIC API";
    $("#chartSource").textContent = simulated ? "SIMULATED PAPER FEED · NOT EXCHANGE QUOTES" : "ZEBPAY PUBLIC MARKET DATA";
    const dot = $(".provider-dot");
    dot.classList.toggle("connected", !simulated);
    dot.classList.toggle("simulated", simulated);
    $(".chart-provider-dot").classList.toggle("connected", !simulated);
    $(".chart-provider-dot").classList.toggle("simulated", simulated);
    $("#exchangeDot").classList.toggle("muted", simulated);
    $("#feedStatus").textContent = simulated ? "PAPER PREVIEW FEED" : "ZEBPAY MARKET DATA";
    $("#feedStatus").style.color = simulated ? "#b79a66" : "#90a099";
  }

  function updatePriceDisplay(quote) {
    if (!quote) return;
    state.market = quote;
    const last = Number(quote.last);
    const percentage = Number(quote.percentage || 0);
    const pair = state.symbol;
    const base = pair.split("/")[0];
    const mark = base === "BTC" ? "₿" : "◆";
    const markNode = $("#selectedCoinMark");
    markNode.textContent = mark;
    markNode.className = `coin-mark large ${base === "BTC" ? "bitcoin" : "ethereum"}`;
    $("#selectedPair").textContent = pair;
    $("#assetName").textContent = `${base === "BTC" ? "Bitcoin" : "Ethereum"} · ZebPay`;
    $("#chartLastPrice").textContent = money(last);
    $("#chartChange").textContent = `${percentage >= 0 ? "+" : ""}${percentage.toFixed(2)}%`;
    $("#chartChange").className = percentage >= 0 ? "positive" : "negative";
    $("#baseUnit").textContent = base;
    $("#priceFromMarket").textContent = state.side === "buy" ? "ASK" : "BID";
    if (!$("#priceInput").value || !$("#priceInput").dataset.touched) {
      const suggested = state.side === "buy" ? (quote.ask || quote.last) : (quote.bid || quote.last);
      $("#priceInput").value = suggested ? String(suggested) : "";
    }
    const submit = $("#submitLabel");
    submit.textContent = `Place ${state.side} limit order`;
    $("#submitOrder").classList.toggle("buy-submit", state.side === "buy");
    $("#submitOrder").classList.toggle("sell-submit", state.side === "sell");
    updateOrderTotal();
    updateOrderButton();
  }

  function updateOrderTotal() {
    const price = Number($("#priceInput").value);
    const amount = Number($("#amountInput").value);
    const total = price * amount;
    $("#orderTotal").innerHTML = `${Number.isFinite(total) ? money(total) : "₹0.00"} <small>INR</small>`;
  }

  function updateOrderButton() {
    const button = $("#submitOrder");
    const price = Number($("#priceInput").value);
    const amount = Number($("#amountInput").value);
    const invalid = !(price > 0 && amount > 0 && Number.isFinite(price * amount));
    const liveBlocked = state.mode === "live" && (!state.liveReady || !state.authenticated || !$("#liveConfirmCheck").checked);
    button.disabled = invalid || liveBlocked;
  }

  async function loadMarket() {
    try {
      const query = new URLSearchParams({ symbol: state.symbol });
      const quote = await api(`/api/market?${query}`);
      updatePriceDisplay(quote);
      updateConnection(quote);
      $("#updatedAt").textContent = `Updated ${new Date(quote.timestamp || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      $("#exchangeDot").classList.toggle("muted", !!quote.is_simulated);
    } catch (error) {
      $("#feedStatus").textContent = "MARKET DATA UNAVAILABLE";
      $("#feedStatus").style.color = "var(--red)";
      $("#exchangeDot").classList.add("muted");
      toast(error.message, true);
    }
  }

  async function loadCandles() {
    try {
      const query = new URLSearchParams({ symbol: state.symbol, timeframe: state.timeframe, limit: "120" });
      const data = await api(`/api/candles?${query}`);
      state.candles = data.candles || [];
      $("#chartEmpty").classList.toggle("hidden", state.candles.length > 0);
      drawChart();
      drawSpark("#watchBtcSpark", state.symbol === "BTC/INR" ? state.candles : null, "#e6b768");
      drawSpark("#watchEthSpark", state.symbol === "ETH/INR" ? state.candles : null, "#9d8cff");
    } catch (error) {
      state.candles = [];
      $("#chartEmpty").classList.remove("hidden");
      drawChart();
      if (state.mode === "live") toast(error.message, true);
    }
  }

  async function loadWatchlist() {
    const pairs = ["BTC/INR", "ETH/INR"];
    for (const pair of pairs) {
      try {
        const data = await api(`/api/market?${new URLSearchParams({ symbol: pair })}`);
        const prefix = pair.startsWith("BTC") ? "Btc" : "Eth";
        $(`#watch${prefix}Price`).textContent = money(data.last);
        const change = Number(data.percentage || 0);
        const changeNode = $(`#watch${prefix}Change`);
        changeNode.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
        changeNode.className = change >= 0 ? "positive" : "negative";
        updateConnectionForWatch(data);
        if (pair === "BTC/INR") drawSpark("#watchBtcSpark", await maybeCandlesForWatch(pair), "#e6b768");
        if (pair === "ETH/INR") drawSpark("#watchEthSpark", await maybeCandlesForWatch(pair), "#9d8cff");
      } catch { /* Keep the last successful watchlist value if a quote request fails. */ }
    }
  }

  async function maybeCandlesForWatch(pair) {
    if (pair === state.symbol && state.candles.length) return state.candles;
    try {
      const query = new URLSearchParams({ symbol: pair, timeframe: "15m", limit: "40" });
      return (await api(`/api/candles?${query}`)).candles || [];
    } catch { return null; }
  }

  function updateConnectionForWatch(quote) {
    if (quote?.is_simulated) {
      $("#exchangeDot").classList.add("muted");
      return;
    }
    $("#exchangeDot").classList.remove("muted");
  }

  async function loadPortfolio() {
    try {
      const data = await api("/api/portfolio");
      $("#equityValue").textContent = data.equity_inr === null ? "Partial" : compactMoney(data.equity_inr);
      $("#equitySub").querySelector(".stat-context").textContent = data.equity_complete ? "INR portfolio value" : "Some assets not priced in INR";
      const inr = (data.balances || []).find((item) => item.currency === "INR");
      $("#freeInrValue").textContent = money(inr?.free || 0);
      $("#openOrdersValue").textContent = String(data.open_orders ?? "—");
      const cap = Number(state.config?.risk?.max_daily_notional || 0);
      const used = Number(data.daily_notional || 0);
      const ratio = cap ? Math.min(999, (used / cap) * 100) : 0;
      $("#dailyUsageTag").textContent = cap ? `${ratio.toFixed(0)}% OF CAP` : "CAP —";
      $("#dailyCapText").textContent = cap ? `Daily turnover cap · ${money(used)} / ${money(cap)}` : "Daily turnover cap · —";
      $("#pnlValue").textContent = data.day_pnl_inr === null ? "—" : money(data.day_pnl_inr);
      $("#pnlValue").className = `stat-value ${data.day_pnl_inr === null ? "neutral" : Number(data.day_pnl_inr) >= 0 ? "positive" : "negative"}`;
    } catch (error) {
      if (error.status === 401) {
        state.authenticated = false;
        updateLivePanel();
        updateOrderButton();
      }
      $("#equityValue").textContent = "Private";
      $("#freeInrValue").textContent = "₹—";
      $("#openOrdersValue").textContent = "—";
      $("#pnlValue").textContent = "—";
    }
  }

  async function loadOrders() {
    try {
      const query = new URLSearchParams({ symbol: state.symbol, limit: "50" });
      const data = await api(`/api/orders?${query}`);
      renderOrders(data.orders || []);
    } catch (error) {
      if (error.status === 401) {
        state.authenticated = false;
        updateLivePanel();
        updateOrderButton();
      }
      renderOrders([]);
    }
  }

  function renderOrders(orders) {
    const tbody = $("#ordersTable");
    $("#orderCountLabel").textContent = `${orders.length} record${orders.length === 1 ? "" : "s"}`;
    if (!orders.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row"><span class="empty-icon">⌁</span><strong>No orders yet</strong><small>${state.mode === "live" && !state.authenticated ? "Sign in to view live orders." : "Paper or live orders from this desk appear here."}</small></td></tr>`;
      return;
    }
    tbody.innerHTML = orders.map((order) => {
      const base = String(order.symbol || "BTC/INR").split("/")[0];
      const time = order.created_at ? new Date(order.created_at).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
      const status = String(order.status || "unknown").toLowerCase();
      const total = Number(order.amount) * Number(order.price);
      const canCancel = status === "open";
      const sideClass = order.side === "buy" ? "positive" : "negative";
      return `<tr>
        <td><span class="order-symbol"><span class="coin-mark ${base === "BTC" ? "bitcoin" : "ethereum"}">${base === "BTC" ? "₿" : "◆"}</span>${escapeHtml(order.symbol || "")}</span></td>
        <td>${escapeHtml(time)}</td>
        <td><span class="order-side ${sideClass}">${escapeHtml(order.side || "—")}</span></td>
        <td>Limit</td>
        <td>${money(order.price)}</td>
        <td>${amountFormatter.format(Number(order.amount) || 0)} ${escapeHtml(base)}</td>
        <td>${money(total)}</td>
        <td><span class="status-badge ${escapeHtml(status)}">${escapeHtml(status)}</span></td>
        <td>${canCancel ? `<button class="cancel-order" data-id="${escapeHtml(order.client_order_id)}" data-symbol="${escapeHtml(order.symbol)}">CANCEL</button>` : ""}</td>
      </tr>`;
    }).join("");
    $$(".cancel-order").forEach((button) => button.addEventListener("click", () => cancelOrder(button.dataset.id, button.dataset.symbol)));
  }

  async function loadSignals() {
    try {
      const query = new URLSearchParams({ symbol: state.symbol, timeframe: state.timeframe });
      const data = await api(`/api/strategy/signals?${query}`);
      const signal = data.signal || {};
      $("#signalBias").textContent = signal.bias || "neutral";
      $("#signalArrow").textContent = signal.bias === "bullish" ? "↗" : signal.bias === "bearish" ? "↘" : "→";
      $("#signalGauge").className = `signal-gauge ${signal.bias || "neutral"}`;
      $("#signalDescription").textContent = `10-candle average is ${Number(signal.spread_pct || 0) >= 0 ? "above" : "below"} the 30-candle average. Research only.`;
      $("#fastSma").textContent = signal.fast_sma ? money(signal.fast_sma) : "—";
      $("#slowSma").textContent = signal.slow_sma ? money(signal.slow_sma) : "—";
      const spread = Number(signal.spread_pct || 0);
      $("#smaSpread").textContent = `${spread >= 0 ? "+" : ""}${spread.toFixed(3)}%`;
      $("#smaSpread").className = spread > 0 ? "positive" : spread < 0 ? "negative" : "";
      updateKronosStatus(data.kronos);
    } catch { /* Keep the last known signal. */ }
  }

  function updateKronosStatus(status = {}) {
    const enabled = !!status.enabled;
    const pathExists = !!status.configured_path_exists;
    const loaded = !!status.loaded;
    $("#kronosDot").classList.toggle("muted", !(enabled && pathExists));
    $("#kronosSideStatus").textContent = loaded ? "Model loaded" : enabled && pathExists ? "Model on demand" : "Optional model";
    const badge = $("#kronosStatus");
    badge.textContent = loaded ? "MODEL READY" : enabled && pathExists ? "CONFIGURED" : "OPTIONAL";
    badge.classList.toggle("ready", loaded);
    if (!enabled) $("#kronosDescription").textContent = "Connect the upstream Kronos model locally to generate a candle forecast. It never sends orders.";
    else if (!pathExists) $("#kronosDescription").textContent = "Kronos is enabled, but its source checkout was not found at the configured KRONOS_PATH.";
    else if (!loaded) $("#kronosDescription").textContent = "Kronos is configured. Its weights load on the first forecast request; forecasts never send orders.";
  }

  async function runForecast() {
    const button = $("#runForecast");
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = "Loading model…";
    try {
      const query = new URLSearchParams({ symbol: state.symbol, timeframe: state.timeframe });
      const result = await api(`/api/forecast?${query}`);
      if (!result.available) {
        $("#kronosDescription").textContent = result.message || "Kronos is not configured.";
        $("#forecastResult").classList.add("hidden");
        return;
      }
      $("#forecastPrice").textContent = money(result.predicted_close);
      const change = Number(result.predicted_change_pct || 0);
      $("#forecastChange").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(3)}%`;
      $("#forecastChange").className = change >= 0 ? "positive" : "negative";
      $("#forecastDirection").textContent = result.direction || "—";
      $("#forecastResult").classList.remove("hidden");
      $("#kronosDescription").textContent = `${result.prediction_steps} candle steps · ${result.latency_ms} ms · not connected to execution.`;
      toast("Kronos research forecast generated.");
      updateKronosStatus({ enabled: true, configured_path_exists: true, loaded: true });
    } catch (error) {
      $("#kronosDescription").textContent = error.message;
      $("#forecastResult").classList.add("hidden");
      toast(error.message, true);
    } finally {
      button.innerHTML = original;
      button.disabled = false;
    }
  }

  function drawChart() {
    const canvas = $("#priceChart");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);
    const candles = state.candles;
    if (!candles.length) return;
    const margin = { left: 9, right: 54, top: 13, bottom: 20 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;
    const highs = candles.map((c) => Number(c[2])).filter(Number.isFinite);
    const lows = candles.map((c) => Number(c[3])).filter(Number.isFinite);
    if (!highs.length || !lows.length) return;
    let min = Math.min(...lows);
    let max = Math.max(...highs);
    const padding = (max - min || max * 0.003) * 0.12;
    min -= padding;
    max += padding;
    const y = (price) => margin.top + ((max - price) / (max - min)) * chartH;
    const xStep = chartW / candles.length;
    const bodyWidth = Math.max(2, Math.min(8, xStep * 0.58));

    ctx.font = "9px SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const price = max - ((max - min) * index / 4);
      const lineY = margin.top + chartH * index / 4;
      ctx.strokeStyle = "rgba(145, 160, 173, .12)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(margin.left, lineY); ctx.lineTo(width - margin.right + 4, lineY); ctx.stroke();
      ctx.fillStyle = "#687580";
      ctx.fillText(shortPrice(price), width - 6, lineY);
    }
    const nowCandle = candles[candles.length - 1];
    const lastY = y(Number(nowCandle[4]));
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(230, 183, 104, .48)";
    ctx.beginPath(); ctx.moveTo(margin.left, lastY); ctx.lineTo(width - margin.right + 4, lastY); ctx.stroke();
    ctx.restore();

    candles.forEach((candle, index) => {
      const open = Number(candle[1]);
      const high = Number(candle[2]);
      const low = Number(candle[3]);
      const close = Number(candle[4]);
      const centerX = margin.left + xStep * (index + .5);
      const color = close >= open ? "#40d1aa" : "#ff747c";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1, xStep > 4 ? 1 : .8);
      ctx.beginPath(); ctx.moveTo(centerX, y(high)); ctx.lineTo(centerX, y(low)); ctx.stroke();
      const top = Math.min(y(open), y(close));
      const bottom = Math.max(y(open), y(close));
      const bodyHeight = Math.max(1, bottom - top);
      ctx.globalAlpha = .88;
      ctx.fillRect(centerX - bodyWidth / 2, top, bodyWidth, bodyHeight);
      ctx.globalAlpha = 1;
    });

    ctx.fillStyle = "#65717c";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const labelIndexes = [0, Math.floor(candles.length * .33), Math.floor(candles.length * .66), candles.length - 1];
    labelIndexes.forEach((index) => {
      const timestamp = Number(candles[index]?.[0]);
      if (!timestamp) return;
      const date = new Date(timestamp);
      const label = state.timeframe === "1d" || state.timeframe === "4h" ? date.toLocaleDateString([], { month: "short", day: "numeric" }) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const posX = margin.left + xStep * (index + .5);
      ctx.fillText(label, Math.min(posX, width - margin.right - 29), height - 4);
    });
  }

  function shortPrice(value) {
    if (value >= 10_000_000) return `₹${(value / 1_000_000).toFixed(1)}m`;
    if (value >= 1_000_000) return `₹${(value / 1_000_000).toFixed(2)}m`;
    if (value >= 100_000) return `₹${(value / 1000).toFixed(0)}k`;
    if (value >= 1000) return `₹${(value / 1000).toFixed(1)}k`;
    return `₹${value.toFixed(0)}`;
  }

  function drawSpark(selector, candles, color) {
    const container = $(selector);
    if (!container) return;
    if (!candles || candles.length < 2) {
      container.innerHTML = "";
      return;
    }
    const values = candles.map((item) => Number(item[4])).filter(Number.isFinite).slice(-32);
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${17 - ((value - min) / range) * 14}`).join(" ");
    container.innerHTML = `<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity=".82"/></svg>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  async function refreshDashboard(initial = false) {
    if (initial) {
      try {
        const health = await api("/api/health");
        setMode(health);
        state.config = await api("/api/config");
        updateKronosStatus(health.kronos);
      } catch (error) {
        toast(`Desk status unavailable: ${error.message}`, true);
      }
    } else {
      try {
        const health = await api("/api/health");
        setMode(health);
      } catch { /* keep last status */ }
    }
    await Promise.all([loadMarket(), loadCandles(), loadWatchlist(), loadPortfolio(), loadOrders(), loadSignals()]);
    updateOrderButton();
  }

  function setSymbol(symbol) {
    state.symbol = symbol;
    $("#symbolSelect").value = symbol;
    $$(".watch-item").forEach((button) => button.classList.toggle("active", button.dataset.symbol === symbol));
    $("#priceInput").dataset.touched = "";
    $("#priceInput").value = "";
    $("#amountInput").value = symbol.startsWith("BTC") ? "0.001" : "0.01";
    $("#forecastResult").classList.add("hidden");
    refreshDashboard();
  }

  async function submitOrder(event) {
    event.preventDefault();
    const price = Number($("#priceInput").value);
    const amount = Number($("#amountInput").value);
    if (!(price > 0 && amount > 0)) return toast("Enter a valid positive amount and limit price.", true);
    let liveConfirmation = null;
    if (state.mode === "live") {
      if (!state.liveReady || !state.authenticated) return toast("Unlock the live desk before submitting an order.", true);
      if (!$("#liveConfirmCheck").checked) return toast("Confirm the live-order warning first.", true);
      const accepted = window.confirm(`REAL LIVE ORDER\n\n${state.side.toUpperCase()} ${amount} ${state.symbol.split("/")[0]} at ${money(price)}.\n\nThis request will be sent to ZebPay. Continue?`);
      if (!accepted) return;
      liveConfirmation = LIVE_CONFIRMATION;
    }
    const button = $("#submitOrder");
    button.disabled = true;
    $("#submitLabel").textContent = "Checking risk limits…";
    try {
      const order = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({ symbol: state.symbol, side: state.side, order_type: "limit", amount: String(amount), price: String(price), live_confirmation: liveConfirmation }),
      });
      $("#liveConfirmCheck").checked = false;
      const filled = order.status === "filled";
      const message = state.mode === "paper"
        ? (filled ? "Paper order filled against the current quote." : "Paper limit order is open. No real order was sent.")
        : `Live ZebPay order ${order.exchange_order_id || "submitted"} · ${order.status}.`;
      showOrderMessage(message, false);
      toast(message);
      await refreshDashboard();
    } catch (error) {
      showOrderMessage(error.message, true);
      toast(error.message, true);
    } finally {
      $("#submitLabel").textContent = `Place ${state.side} limit order`;
      updateOrderButton();
    }
  }

  function showOrderMessage(message, error) {
    const node = $("#orderMessage");
    node.textContent = message;
    node.classList.toggle("error", !!error);
    node.classList.remove("hidden");
    clearTimeout(showOrderMessage.timer);
    showOrderMessage.timer = setTimeout(() => node.classList.add("hidden"), 6500);
  }

  async function cancelOrder(id, symbol) {
    if (state.mode === "live" && !window.confirm("Cancel this real open order on ZebPay?")) return;
    try {
      const query = new URLSearchParams({ symbol });
      await api(`/api/orders/${encodeURIComponent(id)}?${query}`, { method: "DELETE" });
      toast(state.mode === "live" ? "Cancellation request sent to ZebPay." : "Paper order canceled.");
      await refreshDashboard();
    } catch (error) { toast(error.message, true); }
  }

  async function login(event) {
    event.preventDefault();
    $("#loginError").textContent = "";
    const password = $("#operatorPassword").value;
    if (!password) return;
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      $("#operatorPassword").value = "";
      state.authenticated = true;
      updateLivePanel();
      updateOrderButton();
      toast("Live trading desk unlocked.");
      await refreshDashboard();
    } catch (error) {
      $("#loginError").textContent = error.message;
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      state.authenticated = false;
      $("#liveConfirmCheck").checked = false;
      updateLivePanel();
      updateOrderButton();
      toast("Live desk locked.");
      await refreshDashboard();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function setSide(side) {
    state.side = side;
    $("#buyTab").classList.toggle("active", side === "buy");
    $("#sellTab").classList.toggle("active", side === "sell");
    $("#priceInput").dataset.touched = "";
    if (state.market) {
      const suggested = side === "buy" ? (state.market.ask || state.market.last) : (state.market.bid || state.market.last);
      $("#priceInput").value = suggested ? String(suggested) : "";
    }
    if (state.market) updatePriceDisplay(state.market);
    updateOrderButton();
  }

  async function setAmountPercent(percent) {
    try {
      const price = Number($("#priceInput").value) || Number(state.market?.last);
      if (!(price > 0)) return toast("Market price is not available yet.", true);
      if (state.side === "buy") {
        const portfolio = await api("/api/portfolio");
        const inr = (portfolio.balances || []).find((item) => item.currency === "INR");
        const free = Number(inr?.free || 0);
        $("#amountInput").value = String(Math.max(0, free * percent / 100 / price).toFixed(8));
      } else {
        const portfolio = await api("/api/portfolio");
        const base = state.symbol.split("/")[0];
        const balance = (portfolio.balances || []).find((item) => item.currency === base);
        $("#amountInput").value = String(Math.max(0, Number(balance?.free || 0) * percent / 100).toFixed(8));
      }
      updateOrderTotal();
      updateOrderButton();
    } catch (error) { toast(error.message, true); }
  }

  function updateInteractions() {
    $("#noticeDismiss").addEventListener("click", () => $("#paperNotice").classList.add("hidden"));
    $("#refreshButton").addEventListener("click", () => refreshDashboard());
    $("#ordersRefresh").addEventListener("click", () => loadOrders());
    $("#buyTab").addEventListener("click", () => setSide("buy"));
    $("#sellTab").addEventListener("click", () => setSide("sell"));
    $("#symbolSelect").addEventListener("change", (event) => setSymbol(event.target.value));
    $$(".watch-item").forEach((button) => button.addEventListener("click", () => setSymbol(button.dataset.symbol)));
    $$(".timeframe-tabs button").forEach((button) => button.addEventListener("click", () => {
      state.timeframe = button.dataset.timeframe;
      $$(".timeframe-tabs button").forEach((item) => item.classList.toggle("active", item === button));
      $("#forecastResult").classList.add("hidden");
      refreshDashboard();
    }));
    $("#orderForm").addEventListener("submit", submitOrder);
    $("#loginForm").addEventListener("submit", login);
    $("#logoutButton").addEventListener("click", logout);
    $("#runForecast").addEventListener("click", runForecast);
    $("#priceInput").addEventListener("input", () => { $("#priceInput").dataset.touched = "yes"; updateOrderTotal(); updateOrderButton(); });
    $("#amountInput").addEventListener("input", () => { updateOrderTotal(); updateOrderButton(); });
    $("#liveConfirmCheck").addEventListener("change", updateOrderButton);
    $("#priceFromMarket").addEventListener("click", () => {
      if (!state.market) return;
      const price = state.side === "buy" ? (state.market.ask || state.market.last) : (state.market.bid || state.market.last);
      $("#priceInput").value = price ? String(price) : "";
      $("#priceInput").dataset.touched = "yes";
      updateOrderTotal(); updateOrderButton();
    });
    $("#amountMax").addEventListener("click", () => setAmountPercent(100));
    $$(".quick-amounts button").forEach((button) => button.addEventListener("click", () => setAmountPercent(Number(button.dataset.percent))));
    $("#chartExpand").addEventListener("click", () => {
      $(".chart-wrap").classList.toggle("expanded");
      drawChart();
    });
    $("#riskDetails").addEventListener("click", () => {
      const risk = state.config?.risk;
      if (!risk) return toast("Risk settings are loading.");
      toast(`Caps: ${money(risk.max_order_notional)} per order · ${money(risk.max_daily_notional)} daily · ${risk.max_open_orders} open orders.`);
    });
    window.addEventListener("resize", drawChart);
    const chart = $("#priceChart");
    chart.addEventListener("pointermove", showChartTooltip);
    chart.addEventListener("pointerleave", () => $("#chartTooltip").classList.add("hidden"));
  }

  function showChartTooltip(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!state.candles.length) return;
    const ratio = Math.max(0, Math.min(.999, (event.clientX - rect.left) / rect.width));
    const index = Math.max(0, Math.min(state.candles.length - 1, Math.floor(ratio * state.candles.length)));
    const candle = state.candles[index];
    const tip = $("#chartTooltip");
    tip.innerHTML = `O ${money(candle[1])} &nbsp; H ${money(candle[2])}<br>L ${money(candle[3])} &nbsp; C ${money(candle[4])}`;
    tip.classList.remove("hidden");
  }

  function init() {
    updateInteractions();
    $("#amountInput").value = "0.001";
    refreshDashboard(true).then(() => {
      if (state.market) {
        const suggested = state.side === "buy" ? (state.market.ask || state.market.last) : (state.market.bid || state.market.last);
        if (!$("#priceInput").value) $("#priceInput").value = suggested ? String(suggested) : "";
        updateOrderTotal();
      }
    });
    state.refreshTimer = setInterval(() => refreshDashboard(), 15_000);
  }

  init();
})();
