import { create } from 'zustand';

export const useTerminalStore = create((set) => ({
  mode: 'paper',
  health: null,
  serverConfig: null,
  setupInfo: null,
  runtimeConfig: null,
  authenticated: false,
  symbol: 'BTC/INR',
  timeframe: '5m',
  side: 'buy',
  quotes: {},
  candles: [],
  orderBook: null,
  marketTrades: [],
  portfolio: null,
  positions: [],
  orders: [],
  journal: [],
  journalTotal: 0,
  forecast: null,
  strategy: null,
  risk: null,
  wsState: 'connecting',
  feedState: 'connecting',
  lastUpdate: null,
  busy: false,
  toast: null,
  set: (patch) => set(patch),
  setToast: (toast) => set({ toast }),
  setQuote: (quote) => set((state) => ({ quotes: { ...state.quotes, [quote.symbol]: quote }, lastUpdate: Date.now() })),
  updateOrder: (order) => set((state) => {
    if (!order?.client_order_id) return {};
    const existing = state.orders.filter((item) => item.client_order_id !== order.client_order_id);
    return { orders: [order, ...existing].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) };
  }),
}));
