"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/lib/api";
import ConfirmDialog from "@/components/ConfirmDialog";
import StatusBadge from "@/components/StatusBadge";
import { ErrorState, LoadingSkeleton } from "@/components/States";

type RiskStatus = {
  gates: { name: string; blocking: boolean; detail: string }[];
  limits: Record<string, number>;
  kill_switch: { active: boolean; source: string };
  live_trading_enabled: boolean;
  note: string;
};

type Me = { role: string };

export default function RiskPage() {
  const [data, setData] = useState<RiskStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"activate" | "release" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<RiskStatus>("/api/system/risk"));
      setErr(null);
    } catch (e) {
      const ae = e as ApiError;
      setErr({ status: ae.status ?? 0, message: ae.message });
    }
  }, []);

  useEffect(() => {
    load();
    api<Me>("/api/auth/me").then(setMe).catch(() => setMe(null));
  }, [load]);

  const setKillSwitch = async (active: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/system/kill-switch", { method: "POST", body: JSON.stringify({ active }) });
      setNotice(
        active
          ? "Kill switch is now ACTIVE — every new order is blocked."
          : "Kill switch released. Order routing is still blocked by the configuration gate and by adapters that do not implement order placement.",
      );
      await load();
    } catch (e) {
      setNotice(`Change failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (err) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-bold">Risk Management</h1>
        <ErrorState
          title="Could not load risk configuration"
          detail={err.message}
          actionHint={err.status === 401 ? "Sign in — risk configuration requires authentication." : undefined}
          onRetry={load}
        />
        {err.status === 401 && (
          <Link className="text-xs underline" href="/login">
            Go to sign in
          </Link>
        )}
      </div>
    );
  }

  if (!data) return <LoadingSkeleton rows={4} />;

  const isAdmin = me?.role === "admin";

  return (
    <div className="space-y-4">
      <header className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-base font-bold">Risk Management</h1>
        <StatusBadge tone="warn">PARTIAL</StatusBadge>
        <StatusBadge tone={data.kill_switch.active ? "ok" : "bad"}>
          KILL SWITCH {data.kill_switch.active ? "ACTIVE" : "RELEASED"}
        </StatusBadge>
        <span className="text-xs opacity-60">
          values below are the exact configuration the risk engine uses
        </span>
      </header>

      {notice && (
        <div className="panel px-4 py-2 text-xs" style={{ borderColor: "var(--accent)" }} role="status">
          {notice}
        </div>
      )}

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Pre-trade gates</h2>
        <p className="mt-1 text-[11px] opacity-60">
          Any blocking gate rejects the order and writes an audit record. The engine fails closed: an
          unknown state always counts as blocking.
        </p>
        <ul className="mt-3 space-y-2">
          {data.gates.map((g) => (
            <li
              key={g.name}
              className="flex flex-wrap items-center gap-2 rounded px-3 py-2 text-xs"
              style={{ background: "var(--panel-2)" }}
            >
              <StatusBadge tone={g.blocking ? "bad" : "muted"}>
                {g.blocking ? "BLOCKING" : "NOT BLOCKING"}
              </StatusBadge>
              <span className="font-semibold">{g.name.replace(/_/g, " ")}</span>
              <span className="opacity-70">{g.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Configured limits</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {Object.entries(data.limits).map(([k, v]) => (
              <div key={k}>
                <dt className="opacity-50">{k.replace(/_/g, " ")}</dt>
                <dd>{v.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] opacity-60">
            Limits are enforced by the risk engine only where the corresponding check is implemented;
            per-user limits, drawdown controls and replay protection are scheduled with the live
            execution milestone and are listed as missing in the capability matrix.
          </p>
        </div>

        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Kill switch</h2>
          <p className="mt-1 text-xs opacity-70">
            State: <strong>{data.kill_switch.active ? "ACTIVE" : "RELEASED"}</strong> — source:{" "}
            {data.kill_switch.source}.
          </p>
          <p className="mt-2 text-[11px] opacity-60">
            Releasing the kill switch does <strong>not</strong> enable trading. Live trading is also
            governed by the configuration gate and by adapter capabilities, and order placement is not
            implemented for any adapter yet.
          </p>
          {isAdmin ? (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirm("activate")}
                disabled={busy || data.kill_switch.active}
                className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
                style={{ borderColor: "var(--border)" }}
              >
                Activate kill switch
              </button>
              <button
                onClick={() => setConfirm("release")}
                disabled={busy || !data.kill_switch.active}
                className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
                style={{ borderColor: "var(--border)", color: "var(--warn)" }}
              >
                Release kill switch
              </button>
            </div>
          ) : (
            <p className="mt-3 text-[11px] opacity-60">
              Admin role required to change the kill switch. You are signed in as{" "}
              {me ? me.role : "not signed in"}.
            </p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        danger={confirm === "release"}
        title={confirm === "activate" ? "Activate the kill switch?" : "Release the kill switch?"}
        detail={
          confirm === "activate"
            ? "This immediately blocks every new order. Existing positions are unaffected — this control only stops new submissions."
            : "Releasing the kill switch removes one of the three independent gates. Order routing still cannot proceed because live trading is disabled by configuration and no adapter implements order placement. Every change is audited."
        }
        confirmLabel={confirm === "activate" ? "Activate" : "Release"}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && setKillSwitch(confirm === "activate")}
      />

      <p className="text-[11px] opacity-50">{data.note}</p>
    </div>
  );
}
