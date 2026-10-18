"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GROUP_ORDER, SECTIONS, statusLabel, statusTone } from "@/lib/sections";
import StatusBadge from "./StatusBadge";

type Health = {
  status: string;
  database: string;
  environment: string;
  live_trading_enabled: boolean;
  kill_switch_default_active: boolean;
};

type Me = { id: number; email: string; role: string };

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [open, setOpen] = useState(false);

  const loadHealth = useCallback(() => {
    api<Health>("/api/system/health")
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 30_000);
    return () => clearInterval(t);
  }, [loadHealth]);

  const loadMe = useCallback(() => {
    api<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe, pathname]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const signOut = async () => {
    try {
      await api<void>("/api/auth/logout", { method: "POST" });
    } catch {
      // Expired sessions are cleared locally by navigating away; the server rejects them.
    } finally {
      setMe(null);
      router.push("/login");
    }
  };

  const liveEnabled = health?.live_trading_enabled === true;

  return (
    <div className="flex min-h-screen">
      <aside
        className={`${open ? "block" : "hidden"} fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto border-r p-3 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-60 lg:shrink-0`}
        style={{ borderColor: "var(--border)", background: "var(--panel)" }}
        aria-label="Primary"
      >
        <Link
          href="/"
          className="mb-1 block px-2 text-sm font-bold tracking-wide"
          style={{ color: "var(--accent)" }}
        >
          DARKDEVIL<span className="opacity-60">·QUANT</span>
        </Link>
        <p className="mb-3 px-2 text-[10px] uppercase tracking-widest opacity-40">
          multi-exchange terminal
        </p>

        <nav className="space-y-4">
          {GROUP_ORDER.map((group) => (
            <div key={group}>
              <p className="px-2 pb-1 text-[10px] uppercase tracking-widest opacity-40">
                {group}
              </p>
              <ul className="space-y-0.5">
                {SECTIONS.filter((s) => s.group === group).map((s) => {
                  const active = pathname === s.href;
                  return (
                    <li key={s.href}>
                      <Link
                        href={s.href}
                        title={s.note}
                        aria-current={active ? "page" : undefined}
                        className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs ${
                          active ? "font-semibold text-white" : "opacity-70 hover:opacity-100"
                        }`}
                        style={{ background: active ? "var(--panel-2)" : "transparent" }}
                      >
                        <span>{s.label}</span>
                        <StatusBadge tone={statusTone(s.status)}>
                          {statusLabel(s.status)}
                        </StatusBadge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-4 border-t px-2 pt-3 text-[10px] leading-relaxed opacity-50" style={{ borderColor: "var(--border)" }}>
          Data shown is fetched live from each exchange and labelled with its
          source, timestamp and freshness. Unavailable data is shown as
          unavailable, never simulated.
        </div>
      </aside>

      {open && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 lg:hidden"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setOpen(false)}
        />
      )}

      <div className="min-w-0 flex-1">
        <header
          className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2"
          style={{ borderColor: "var(--border)", background: "var(--bg)" }}
        >
          <button
            className="rounded border px-2 py-1 text-xs lg:hidden"
            style={{ borderColor: "var(--border)" }}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle navigation"
          >
            ☰
          </button>

          <nav aria-label="Breadcrumb" className="text-xs opacity-70">
            {SECTIONS.find((s) => s.href === pathname)?.label ?? "DarkDevil Quant"}
          </nav>

          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
            <StatusBadge tone={health?.status === "ok" ? "ok" : "warn"}>
              SYS {health ? health.status.toUpperCase() : "…"}
            </StatusBadge>
            <StatusBadge tone={health?.database === "ok" ? "ok" : "warn"}>
              DB {health?.database ?? "…"}
            </StatusBadge>
            <StatusBadge tone="muted">{health?.environment ?? "…"}</StatusBadge>
            <StatusBadge tone={liveEnabled ? "bad" : "ok"}>
              {liveEnabled ? "LIVE TRADING ENABLED" : "LIVE TRADING OFF"}
            </StatusBadge>
            {authChecked && me ? (
              <span className="flex items-center gap-2">
                <span className="opacity-70" title={me.email}>
                  {me.email}
                </span>
                <StatusBadge tone="muted">{me.role}</StatusBadge>
                <button
                  onClick={signOut}
                  className="rounded border px-2 py-1 text-[11px]"
                  style={{ borderColor: "var(--border)" }}
                >
                  Sign out
                </button>
              </span>
            ) : authChecked ? (
              <Link
                href="/login"
                className="rounded px-2 py-1 text-[11px] font-semibold"
                style={{ background: "var(--accent)" }}
              >
                Sign in
              </Link>
            ) : null}
          </div>
        </header>

        {liveEnabled && (
          <div
            className="border-b px-4 py-2 text-xs font-semibold"
            style={{ borderColor: "var(--down)", color: "var(--down)" }}
            role="alert"
          >
            Live trading is enabled by configuration. Order routing is still
            blocked unless the adapter, risk checks and reconciliation are
            verified.
          </div>
        )}

        <main className="mx-auto max-w-7xl px-4 pb-12 pt-4">{children}</main>
      </div>
    </div>
  );
}
