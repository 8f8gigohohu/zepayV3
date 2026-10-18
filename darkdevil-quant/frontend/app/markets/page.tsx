"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, api, fmtAge, fmtNum, Wrapped } from "@/lib/api";
import CandleChart, { Kline } from "@/components/CandleChart";
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

const INTERVALS: { value: string; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

export default function Markets() {
  const [exchange, setExchange] = useState("binance");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Wrapped<Ticker[]> | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [interval, setIntervalValue] = useState("1h");
  const [candles, setCandles] = useState<Wrapped<Kline[]> | null>(null);
  const [candlesErr, setCandlesErr] = useState<string | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Wrapped<Ticker[]>>(`/api/market/${exchange}/tickers`);
      setRows(data);
      setErr(null);
    } catch (e) {
      const ae = e as ApiError;
      setErr({ status: ae.status ?? 0, message: ae.message });
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [exchange]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 20_000);
    return () => clearInterval(iv);
  }, [load]);

  const filtered = useMemo(() => {
    const items = rows?.data ?? [];
    return items
      .filter((t) => t.symbol.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => (b.quote_volume ?? 0) - (a.quote_volume ?? 0));
  }, [rows, query]);

  // Pick a sensible default symbol once the list arrives.
  useEffect(() => {
    if (!selected && filtered.length > 0) setSelected(filtered[0].symbol);
  }, [filtered, selected]);

  const loadCandles = useCallback(async () => {
    if (!selected) return;
    setCandlesLoading(true);
    try {
      const out = await api<Wrapped<Kline[]>>(
        `/api/market/${exchange}/klines?symbol=${encodeURIComponent(selected)}&interval=${interval}&limit=200`,
      );
      setCandles(out);
      setCandlesErr(null);
    } catch (e) {
      setCandlesErr((e as Error).message);
      setCandles(null);
    } finally {
      setCandlesLoading(false);
    }
  }, [exchange, selected, interval]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  const stale = rows ? rows.age_ms > rows.stale_after_ms : false;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-md p-1" style={{ background: "var(--panel)" }} role="tablist">
          {["binance", "zebpay"].map((x) => (
            <button
              key={x}
              role="tab"
              aria-selected={exchange === x}
              onClick={() => {
                setExchange(x);
                setSelected(null);
                setCandles(null);
              }}
              className={`rounded px-3 py-1 text-xs ${exchange === x ? "font-bold text-white" : "opacity-60"}`}
              style={{ background: exchange === x ? "var(--accent)" : "transparent" }}
            >
              {x}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search symbol…"
          aria-label="Search symbol"
          className="w-48 rounded-md border px-3 py-1.5 text-xs outline-none"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        />
        <StatusBadge tone={stale ? "warn" : "muted"}>
          {rows
            ? stale
              ? "STALE DATA"
              : `fresh · fetched ${fmtAge(rows.age_ms)} ago`
            : "loading"}
        </StatusBadge>
        <span className="text-[11px] opacity-50">REST polling · 20s refresh</span>
      </section>

      {err && (
        <ErrorState
          title="Could not load market list"
          detail={err.message}
          actionHint={err.status === 401 ? "Sign in — market endpoints require authentication." : undefined}
          onRetry={load}
        />
      )}
      {err?.status === 401 && (
        <Link className="text-xs underline" href="/login">
          Go to sign in
        </Link>
      )}

      {loading && !rows && <LoadingSkeleton rows={5} />}
      {!loading && !err && rows && filtered.length === 0 && (
        <EmptyState title="No symbols matched" hint="Clear the search box to see all markets." />
      )}

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1.4fr]">
        <section className="panel overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 text-[11px] opacity-60" style={{ background: "var(--panel)" }}>
                <tr>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2 text-right">Last</th>
                  <th className="px-3 py-2 text-right">24h %</th>
                  <th className="px-3 py-2 text-right">Quote vol</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((t) => {
                  const up = (t.change_pct ?? 0) >= 0;
                  const active = selected === t.symbol;
                  return (
                    <tr
                      key={t.symbol}
                      onClick={() => setSelected(t.symbol)}
                      className="cursor-pointer border-t hover:bg-white/5"
                      style={{
                        borderColor: "var(--border)",
                        background: active ? "var(--panel-2)" : undefined,
                      }}
                      aria-selected={active}
                    >
                      <td className="px-3 py-1.5 font-semibold">{t.symbol}</td>
                      <td className="px-3 py-1.5 text-right">{fmtNum(t.last)}</td>
                      <td className="px-3 py-1.5 text-right" style={{ color: up ? "var(--up)" : "var(--down)" }}>
                        {t.change_pct === null ? "—" : `${up ? "+" : ""}${t.change_pct.toFixed(2)}%`}
                      </td>
                      <td className="px-3 py-1.5 text-right opacity-70">{fmtNum(t.quote_volume, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows && (
            <div className="border-t px-3 py-2" style={{ borderColor: "var(--border)" }}>
              <DataFreshness
                ageMs={rows.age_ms}
                staleAfterMs={rows.stale_after_ms}
                sourceUrl={rows.source_url}
                endpoint={rows.endpoint}
                verified={rows.verified}
              />
            </div>
          )}
        </section>

        <section className="panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{selected ?? "Select a market"}</h2>
            {!candles && <StatusBadge tone="muted">no chart data</StatusBadge>}
            <div className="ml-auto flex gap-1">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.value}
                  onClick={() => setIntervalValue(iv.value)}
                  className={`rounded px-2 py-1 text-[11px] ${interval === iv.value ? "font-bold text-white" : "opacity-60"}`}
                  style={{ background: interval === iv.value ? "var(--accent)" : "var(--panel-2)" }}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2">
            {candlesLoading && !candles ? (
              <LoadingSkeleton rows={4} />
            ) : candlesErr ? (
              <ErrorState
                title="Chart unavailable"
                detail={candlesErr}
                actionHint="Interval or symbol may not be supported by this exchange; nothing is drawn in place of real data."
                onRetry={loadCandles}
              />
            ) : candles ? (
              <>
                <CandleChart candles={candles.data} />
                <div className="mt-2">
                  <DataFreshness
                    ageMs={candles.age_ms}
                    staleAfterMs={candles.stale_after_ms}
                    sourceUrl={candles.source_url}
                    endpoint={candles.endpoint}
                    verified={candles.verified}
                  />
                </div>
              </>
            ) : (
              <EmptyState title="Pick a symbol to load candles" />
            )}
          </div>

          {candles && candles.data.length > 0 && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <div>
                <dt className="opacity-50">Open</dt>
                <dd>{fmtNum(candles.data[0].open)}</dd>
              </div>
              <div>
                <dt className="opacity-50">Last close</dt>
                <dd>{fmtNum(candles.data[candles.data.length - 1].close)}</dd>
              </div>
              <div>
                <dt className="opacity-50">Period high</dt>
                <dd>{fmtNum(Math.max(...candles.data.map((c) => c.high)))}</dd>
              </div>
              <div>
                <dt className="opacity-50">Period low</dt>
                <dd>{fmtNum(Math.min(...candles.data.map((c) => c.low)))}</dd>
              </div>
            </dl>
          )}
        </section>
      </div>

      <p className="text-[11px] leading-relaxed opacity-50">
        ZebPay has no documented public spot WebSocket, so this market is always REST-polled and
        labelled as such. Candles are drawn only from candles the exchange actually returned for the
        selected interval; unsupported combinations surface an error instead of a fabricated series.
      </p>
    </div>
  );
}
