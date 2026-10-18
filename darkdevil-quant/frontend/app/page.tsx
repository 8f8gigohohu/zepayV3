"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, api, fmtAge, fmtNum, Wrapped } from "@/lib/api";
import { SECTIONS } from "@/lib/sections";
import CapabilityMatrix from "@/components/CapabilityMatrix";
import DataFreshness from "@/components/DataFreshness";
import StatusBadge from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/States";

type Ticker = {
  symbol: string;
  last: number;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  change_pct: number | null;
  base_volume: number | null;
  quote_volume: number | null;
  ts_ms: number;
};

type Level = { price: number; quantity: number };
type OrderBook = { bids: Level[]; asks: Level[]; ts_ms: number };
type Trade = { id: string; price: number; quantity: number; ts_ms: number; buyer_is_maker: boolean };

type SysHealth = {
  status: string;
  database: string;
  environment: string;
  live_trading_enabled: boolean;
  kill_switch_default_active: boolean;
};

type ExchangeStatus = {
  exchanges: Record<
    string,
    {
      registered: boolean;
      overall: string;
      reachable: boolean | null;
      error: string | null;
      restricted?: boolean;
      cached: boolean;
      capabilities: Record<string, { status: string; detail: string }>;
    }
  >;
};

const MARKETS: { exchange: string; symbol: string; label: string }[] = [
  { exchange: "binance", symbol: "BTCUSDT", label: "Binance · BTC/USDT" },
  { exchange: "binance", symbol: "ETHUSDT", label: "Binance · ETH/USDT" },
  { exchange: "binance", symbol: "SOLUSDT", label: "Binance · SOL/USDT" },
  { exchange: "zebpay", symbol: "BTC-INR", label: "ZebPay · BTC/INR" },
  { exchange: "zebpay", symbol: "ETH-INR", label: "ZebPay · ETH/INR" },
];

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="opacity-50">{label}</span> <span>{children}</span>
    </div>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<SysHealth | null>(null);
  const [exStatus, setExStatus] = useState<ExchangeStatus | null>(null);
  const [exErr, setExErr] = useState<string | null>(null);
  const [marketIdx, setMarketIdx] = useState(0);
  const [ticker, setTicker] = useState<Wrapped<Ticker[]> | null>(null);
  const [book, setBook] = useState<Wrapped<OrderBook> | null>(null);
  const [trades, setTrades] = useState<Wrapped<Trade[]> | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const market = MARKETS[marketIdx];

  const loadHealth = useCallback(() => {
    api<SysHealth>("/api/system/health").then(setHealth).catch(() => setHealth(null));
    api<ExchangeStatus>("/api/system/exchanges")
      .then((s) => {
        setExStatus(s);
        setExErr(null);
      })
      .catch((e) => setExErr((e as Error).message));
  }, []);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    try {
      const t = await api<Wrapped<Ticker[]>>(
        `/api/market/${market.exchange}/tickers?symbol=${encodeURIComponent(market.symbol)}`,
      );
      setTicker(t);
      setErr(null);
      setUpdatedAt(Date.now());
      // Secondary panels are independent: a failure here must not blank the price.
      api<Wrapped<OrderBook>>(`/api/market/${market.exchange}/orderbook?symbol=${encodeURIComponent(market.symbol)}&limit=10`)
        .then(setBook)
        .catch(() => setBook(null));
      api<Wrapped<Trade[]>>(`/api/market/${market.exchange}/trades?symbol=${encodeURIComponent(market.symbol)}&limit=15`)
        .then(setTrades)
        .catch(() => setTrades(null));
    } catch (e) {
      const ae = e as ApiError;
      setErr({ status: ae.status ?? 0, message: ae.message });
      setTicker(null);
      setBook(null);
      setTrades(null);
    } finally {
      setLoading(false);
    }
  }, [market.exchange, market.symbol]);

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 30_000);
    return () => clearInterval(t);
  }, [loadHealth]);

  useEffect(() => {
    loadMarket();
    const t = setInterval(loadMarket, 15_000);
    return () => clearInterval(t);
  }, [loadMarket]);

  const best = ticker?.data?.[0];
  const spread =
    best?.bid && best?.ask ? best.ask - best.bid : null;
  const plannedCount = SECTIONS.filter((s) => s.status === "dev").length;

  return (
    <div className="space-y-4">
      <section className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-xs">
        <Stat label="System">
          <span style={{ color: health?.status === "ok" ? "var(--up)" : "var(--warn)" }}>
            {health ? health.status.toUpperCase() : "checking…"}
          </span>
        </Stat>
        <Stat label="Database">{health?.database ?? "—"}</Stat>
        <Stat label="Environment">{health?.environment ?? "—"}</Stat>
        <Stat label="Kill switch">
          <span style={{ color: "var(--up)" }}>ACTIVE (default, fail-closed)</span>
        </Stat>
        <Stat label="Live trading">
          <span style={{ color: health?.live_trading_enabled ? "var(--down)" : "var(--up)" }}>
            {health?.live_trading_enabled ? "ENABLED" : "DISABLED"}
          </span>
        </Stat>
        <Stat label="Last dashboard refresh">{updatedAt ? fmtAge(Date.now() - updatedAt) + " ago" : "—"}</Stat>
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold">Market overview</h1>
          <select
            aria-label="Select market"
            value={marketIdx}
            onChange={(e) => setMarketIdx(Number(e.target.value))}
            className="rounded border px-2 py-1 text-xs"
            style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
          >
            {MARKETS.map((m, i) => (
              <option key={`${m.exchange}-${m.symbol}`} value={i}>
                {m.label}
              </option>
            ))}
          </select>
          <StatusBadge tone="muted">REST polling 15s</StatusBadge>
          <span className="text-[11px] opacity-50">
            WebSocket streaming arrives in a later milestone; this is labelled polling, not a stream.
          </span>
        </div>

        {err ? (
          <div className="mt-3">
            <ErrorState
              title="Market data unavailable"
              detail={err.message}
              actionHint={
                err.status === 401
                  ? "Sign in to view market data — the backend requires authentication for market endpoints."
                  : "No values are substituted when the exchange is unreachable."
              }
              onRetry={loadMarket}
            />
            {err.status === 401 && (
              <Link className="mt-2 inline-block text-xs underline" href="/login">
                Go to sign in
              </Link>
            )}
          </div>
        ) : loading && !best ? (
          <div className="mt-3">
            <LoadingSkeleton rows={3} />
          </div>
        ) : best ? (
          <>
            <div className="mt-3 flex flex-wrap items-baseline gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-widest opacity-50">{best.symbol}</div>
                <div className="text-3xl font-bold">{fmtNum(best.last)}</div>
              </div>
              <StatusBadge tone={(best.change_pct ?? 0) >= 0 ? "ok" : "bad"}>
                {(best.change_pct ?? 0) >= 0 ? "▲" : "▼"} {Math.abs(best.change_pct ?? 0).toFixed(2)}% 24h
              </StatusBadge>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs opacity-80 sm:grid-cols-4">
                <Stat label="Bid">{fmtNum(best.bid)}</Stat>
                <Stat label="Ask">{fmtNum(best.ask)}</Stat>
                <Stat label="24h High">{fmtNum(best.high)}</Stat>
                <Stat label="24h Low">{fmtNum(best.low)}</Stat>
                <Stat label="Base vol">{fmtNum(best.base_volume, 0)}</Stat>
                <Stat label="Quote vol">{fmtNum(best.quote_volume, 0)}</Stat>
                <Stat label="Spread">{fmtNum(spread)}</Stat>
                <Stat label="Upstream ts">{new Date(best.ts_ms).toLocaleTimeString()}</Stat>
              </div>
            </div>
            <div className="mt-3">
              <DataFreshness
                ageMs={ticker?.age_ms ?? 0}
                staleAfterMs={ticker?.stale_after_ms ?? 15000}
                sourceUrl={ticker?.source_url}
                endpoint={ticker?.endpoint}
                verified={ticker?.verified}
              />
            </div>
          </>
        ) : null}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-2 text-sm font-semibold">Order book (top 10)</h2>
          {!book ? (
            <p className="text-xs opacity-60">
              Order book unavailable for this market right now — not shown rather than estimated.
            </p>
          ) : (
            <>
              <table className="w-full text-[11px]">
                <thead className="opacity-50">
                  <tr>
                    <th className="text-left">Bid price</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Ask price</th>
                    <th className="text-right">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: Math.max(book.data.bids.length, book.data.asks.length) })
                    .slice(0, 10)
                    .map((_, i) => {
                      const bid = book.data.bids[i];
                      const ask = book.data.asks[i];
                      return (
                        <tr key={i}>
                          <td className="py-0.5" style={{ color: "var(--up)" }}>
                            {bid ? fmtNum(bid.price) : "—"}
                          </td>
                          <td className="py-0.5 text-right opacity-70">{bid ? fmtNum(bid.quantity, 4) : "—"}</td>
                          <td className="py-0.5 text-right" style={{ color: "var(--down)" }}>
                            {ask ? fmtNum(ask.price) : "—"}
                          </td>
                          <td className="py-0.5 text-right opacity-70">{ask ? fmtNum(ask.quantity, 4) : "—"}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <div className="mt-2">
                <DataFreshness
                  ageMs={book.age_ms}
                  staleAfterMs={book.stale_after_ms}
                  sourceUrl={book.source_url}
                  verified={book.verified}
                />
              </div>
            </>
          )}
        </div>

        <div className="panel p-4">
          <h2 className="mb-2 text-sm font-semibold">Recent trades</h2>
          {!trades || trades.data.length === 0 ? (
            <p className="text-xs opacity-60">No public trades available for this market right now.</p>
          ) : (
            <>
              <table className="w-full text-[11px]">
                <thead className="opacity-50">
                  <tr>
                    <th className="text-left">Price</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Side</th>
                    <th className="text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.data.slice(0, 10).map((t) => (
                    <tr key={t.id}>
                      <td className="py-0.5">{fmtNum(t.price)}</td>
                      <td className="py-0.5 text-right opacity-70">{fmtNum(t.quantity, 4)}</td>
                      <td
                        className="py-0.5 text-right"
                        style={{ color: t.buyer_is_maker ? "var(--down)" : "var(--up)" }}
                      >
                        {t.buyer_is_maker ? "sell" : "buy"}
                      </td>
                      <td className="py-0.5 text-right opacity-60">
                        {new Date(t.ts_ms).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2">
                <DataFreshness
                  ageMs={trades.age_ms}
                  staleAfterMs={trades.stale_after_ms}
                  sourceUrl={trades.source_url}
                  verified={trades.verified}
                />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Exchange adapters — capability report</h2>
          <Link href="/exchanges" className="text-xs underline opacity-70">
            manage credentials
          </Link>
        </div>
        {exErr && !exStatus && <p className="mt-2 text-xs" style={{ color: "var(--warn)" }}>Status API error: {exErr}</p>}
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          {exStatus?.exchanges
            ? Object.entries(exStatus.exchanges).map(([name, s]) => (
                <div
                  key={name}
                  className="rounded-md p-3"
                  style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {name}
                    <StatusBadge tone={s.reachable ? "ok" : s.restricted ? "warn" : "bad"}>
                      {s.reachable === null
                        ? "CHECKING"
                        : s.reachable
                        ? "REACHABLE"
                        : s.restricted
                        ? "GEO-RESTRICTED"
                        : "UNREACHABLE"}
                    </StatusBadge>
                    {s.cached && <StatusBadge tone="muted">cached 30s</StatusBadge>}
                  </div>
                  {s.error && (
                    <div className="mt-1 text-[11px]" style={{ color: "var(--down)" }}>
                      {s.error}
                    </div>
                  )}
                  <CapabilityMatrix caps={s.capabilities} />
                </div>
              ))
            : !exErr && <EmptyState title="Loading exchange status…" />}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="panel p-4 lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">Workspace status</h2>
          <p className="text-[11px] opacity-60">
            {SECTIONS.length - plannedCount} of {SECTIONS.length} sections are connected to
            implemented backend capability. The remaining {plannedCount} are openly marked as
            development work with their milestone.
          </p>
          <ul className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <li key={s.href} className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: "var(--panel-2)" }}>
                <Link href={s.href} className="truncate opacity-80 hover:opacity-100">
                  {s.label}
                </Link>
                <StatusBadge tone={s.status === "live" ? "ok" : s.status === "partial" ? "warn" : "muted"}>
                  {s.status === "live" ? "LIVE" : s.status === "partial" ? "PARTIAL" : "PLANNED"}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel p-4 text-xs leading-relaxed opacity-80">
          <h2 className="mb-2 text-sm font-semibold">Safety posture</h2>
          <ul className="list-inside list-disc space-y-1">
            <li>Order submission is fail-closed at three independent layers.</li>
            <li>Market data is rejected by the risk engine when older than 30s.</li>
            <li>No page fabricates prices, balances or fills; failures are shown as failures.</li>
            <li>Live trading stays disabled until adapters, risk checks and reconciliation pass acceptance.</li>
          </ul>
          <p className="mt-2 text-[11px] opacity-60">
            See the acceptance report and capability matrix in the repository docs.
          </p>
        </div>
      </section>
    </div>
  );
}
