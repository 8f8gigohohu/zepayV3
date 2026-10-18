"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import CapabilityMatrix from "@/components/CapabilityMatrix";
import StatusBadge from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/States";

type Health = {
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

type Version = { app: string; version: string; milestone: number };

export default function SystemPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [exchanges, setExchanges] = useState<ExchangeStatus | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, e, v] = await Promise.all([
        api<Health>("/api/system/health"),
        api<ExchangeStatus>("/api/system/exchanges"),
        api<Version>("/api/version"),
      ]);
      setHealth(h);
      setExchanges(e);
      setVersion(v);
      setErr(null);
      setCheckedAt(Date.now());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !health) return <LoadingSkeleton rows={4} />;
  if (err && !health) return <ErrorState title="Health check failed" detail={err} onRetry={load} />;

  return (
    <div className="space-y-4">
      <header className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-base font-bold">System Health</h1>
        <StatusBadge tone={health?.status === "ok" ? "ok" : "warn"}>
          {health?.status?.toUpperCase() ?? "UNKNOWN"}
        </StatusBadge>
        <span className="text-xs opacity-60">
          app {version?.app} v{version?.version} · milestone {version?.milestone}
        </span>
        <span className="ml-auto text-[11px] opacity-50">
          {checkedAt ? `checked ${new Date(checkedAt).toLocaleTimeString()}` : ""} · auto 30s
        </span>
      </header>

      {err && health && (
        <div className="panel px-4 py-2 text-xs" style={{ color: "var(--warn)" }} role="status">
          Last refresh failed: {err} — showing the previous reading.
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "API status", value: health?.status ?? "—", tone: health?.status === "ok" ? "ok" : "warn" },
          { label: "Database", value: health?.database ?? "—", tone: health?.database === "ok" ? "ok" : "bad" },
          { label: "Environment", value: health?.environment ?? "—", tone: "muted" },
          {
            label: "Live trading",
            value: health?.live_trading_enabled ? "ENABLED" : "DISABLED",
            tone: health?.live_trading_enabled ? "bad" : "ok",
          },
        ].map((c) => (
          <div key={c.label} className="panel p-4">
            <p className="text-[11px] uppercase tracking-widest opacity-50">{c.label}</p>
            <p className="mt-1 text-lg font-bold">{String(c.value).toUpperCase()}</p>
            <StatusBadge tone={c.tone as "ok" | "warn" | "bad" | "muted"}>live value</StatusBadge>
          </div>
        ))}
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Exchange reachability & capability</h2>
          <span className="text-[11px] opacity-50">
            reachability is a real ping; results are cached for 30s
          </span>
        </div>
        {!exchanges ? (
          <EmptyState title="Exchange status unavailable" hint={err ?? undefined} />
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {Object.entries(exchanges.exchanges).map(([name, s]) => (
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
                  {s.cached && <StatusBadge tone="muted">cached</StatusBadge>}
                </div>
                {s.error && (
                  <div className="mt-1 break-words text-[11px]" style={{ color: "var(--down)" }}>
                    {s.error}
                  </div>
                )}
                <CapabilityMatrix caps={s.capabilities} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel px-4 py-3 text-[11px] leading-relaxed opacity-70">
        <strong>Not implemented in this health surface:</strong> readiness checks that depend on
        background workers, queue depth, WebSocket stream health and database migration status. Those
        arrive with the streaming and deployment-hardening milestones; a green status here means the
        API responded and the database answered a query — nothing more.
      </section>
    </div>
  );
}
