"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, api, fmtTime } from "@/lib/api";
import CapabilityMatrix from "@/components/CapabilityMatrix";
import ConfirmDialog from "@/components/ConfirmDialog";
import StatusBadge, { StatusTone } from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/States";

type Connection = {
  exchange: string;
  connected: boolean;
  state: string;
  state_detail: string;
  credential_stored: boolean;
  key_masked: string | null;
  last_test_status: string | null;
  last_test_detail: string | null;
  last_test_at: string | null;
  private_api_status: string;
  place_order_status: string;
  cancel_order_status: string;
  order_history_status: string;
  trading_state: string;
  capabilities: Record<string, { status: string; detail: string }>;
};

type StatusResponse = {
  connections: Connection[];
  guidance: Record<string, string>;
};

type TestResult = {
  exchange: string;
  connected: boolean;
  status: string;
  detail: string;
  state: string;
  state_detail: string;
  place_order_status?: string;
};

const STATE_TONE: Record<string, StatusTone> = {
  NOT_CONFIGURED: "muted",
  CONFIGURED_UNTESTED: "warn",
  CONNECTED_READ_ONLY: "ok",
  VERIFIED_FOR_TRADING: "ok",
  ERROR: "bad",
  UNSUPPORTED: "muted",
};

function TestOutcome({ result }: { result: TestResult }) {
  const ok = result.state === "CONNECTED_READ_ONLY";
  return (
    <div
      className="mt-2 rounded border px-3 py-2 text-[11px] leading-relaxed"
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={ok ? "ok" : "bad"}>
          {ok ? "ACCOUNT READ OK" : "TEST DID NOT SUCCEED"}
        </StatusBadge>
        <span className="opacity-70">{result.state}</span>
      </div>
      <p className="mt-1 break-words opacity-80">{result.detail}</p>
      <p className="mt-1 opacity-50">
        Order placement capability: {result.place_order_status ?? "unknown"} — a successful account
        read never implies trading is enabled.
      </p>
    </div>
  );
}

function ConnectionCard({
  conn,
  busy,
  testResult,
  onTest,
  onDisconnect,
}: {
  conn: Connection;
  busy: string | null;
  testResult?: TestResult;
  onTest: (exchange: string) => void;
  onDisconnect: (exchange: string) => void;
}) {
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold">{conn.exchange}</h2>
        <StatusBadge tone={STATE_TONE[conn.state] ?? "muted"}>
          {conn.state.replace(/_/g, " ")}
        </StatusBadge>
        <StatusBadge tone={conn.trading_state === "VERIFIED_FOR_TRADING" ? "ok" : "muted"}>
          {conn.trading_state.replace(/_/g, " ")}
        </StatusBadge>
      </div>

      <p className="mt-1 text-[11px] opacity-70">{conn.state_detail}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="opacity-50">Stored key</dt>
        <dd>{conn.key_masked ?? "—"}</dd>
        <dt className="opacity-50">Last test</dt>
        <dd>{conn.last_test_status ?? "never"}</dd>
        <dt className="opacity-50">Tested at</dt>
        <dd>{fmtTime(conn.last_test_at)}</dd>
        <dt className="opacity-50">Private API</dt>
        <dd>{String(conn.private_api_status).replace(/_/g, " ")}</dd>
      </dl>

      {conn.last_test_detail && (
        <p className="mt-2 break-words text-[11px] opacity-60">{conn.last_test_detail}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => onTest(conn.exchange)}
          disabled={!conn.credential_stored || busy !== null}
          title={conn.credential_stored ? "Perform a real authenticated account read" : "Store credentials first"}
          className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          {busy === `test:${conn.exchange}` ? "Testing…" : "Test connection"}
        </button>
        <button
          onClick={() => onDisconnect(conn.exchange)}
          disabled={!conn.credential_stored || busy !== null}
          className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--border)", color: "var(--down)" }}
        >
          Disconnect
        </button>
      </div>

      {testResult && <TestOutcome result={testResult} />}

      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] opacity-60">Capability matrix</summary>
        <CapabilityMatrix caps={conn.capabilities} />
      </details>
    </section>
  );
}

export default function ExchangeConnectionsPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [form, setForm] = useState({ exchange: "", api_key: "", api_secret: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const out = await api<StatusResponse>("/api/connections/status");
      setData(out);
      setErr(null);
    } catch (e) {
      const ae = e as ApiError;
      setErr({ status: ae.status ?? 0, message: ae.message });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form.exchange || !form.api_key || !form.api_secret) return;
    setBusy("save");
    setNotice(null);
    try {
      await api("/api/connections", {
        method: "POST",
        body: JSON.stringify({ ...form, test_now: false }),
      });
      setNotice(
        `${form.exchange}: credentials encrypted and stored. They are never returned by the API — ` +
          "run Test connection to verify read-only account access.",
      );
      setForm({ exchange: form.exchange, api_key: "", api_secret: "" });
      await load();
    } catch (e) {
      setNotice(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (exchange: string) => {
    setBusy(`test:${exchange}`);
    try {
      const out = await api<TestResult>(`/api/connections/${exchange}/test`, { method: "POST" });
      setTests((t) => ({ ...t, [exchange]: out }));
      await load();
    } catch (e) {
      const message = (e as Error).message;
      setTests((t) => ({
        ...t,
        [exchange]: {
          exchange,
          connected: false,
          status: "fail",
          detail: message,
          state: "ERROR",
          state_detail: message,
        },
      }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (exchange: string) => {
    setBusy(`del:${exchange}`);
    try {
      await api(`/api/connections/${exchange}`, { method: "DELETE" });
      setTests((t) => {
        const copy = { ...t };
        delete copy[exchange];
        return copy;
      });
      await load();
    } catch (e) {
      setNotice(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  if (loading && !data) return <LoadingSkeleton rows={4} />;

  if (err) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-bold">Exchange Connections</h1>
        <ErrorState
          title="Could not load connection status"
          detail={err.message}
          actionHint={
            err.status === 401
              ? "Sign in first — connection management is per-account and requires authentication."
              : undefined
          }
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

  const connections = data?.connections ?? [];

  return (
    <div className="space-y-4">
      <header className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-base font-bold">Exchange Connections</h1>
        <StatusBadge tone="warn">PARTIAL</StatusBadge>
        <span className="text-xs opacity-60">
          credentials are encrypted at rest; connection state is always derived from a real test
        </span>
      </header>

      {notice && (
        <div className="panel px-4 py-2 text-xs" style={{ borderColor: "var(--accent)" }} role="status">
          {notice}
        </div>
      )}

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Add or replace credentials</h2>
        <p className="mt-1 text-[11px] leading-relaxed opacity-60">
          Create exchange API keys with <strong>withdrawals disabled</strong> and the minimum
          permissions you need. Secrets are sent only to this backend, encrypted at rest, and never
          returned by any endpoint or written to logs.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block opacity-60">Exchange</span>
            <select
              value={form.exchange}
              onChange={(e) => setForm({ ...form, exchange: e.target.value })}
              className="mt-1 rounded border px-2 py-1.5 text-xs"
              style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
            >
              <option value="">select…</option>
              {connections.map((c) => (
                <option key={c.exchange} value={c.exchange}>
                  {c.exchange}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block opacity-60">API key</span>
            <input
              type="password"
              autoComplete="off"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              className="mt-1 w-56 rounded border px-2 py-1.5 text-xs"
              style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
            />
          </label>
          <label className="text-xs">
            <span className="block opacity-60">API secret</span>
            <input
              type="password"
              autoComplete="off"
              value={form.api_secret}
              onChange={(e) => setForm({ ...form, api_secret: e.target.value })}
              className="mt-1 w-56 rounded border px-2 py-1.5 text-xs"
              style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
            />
          </label>
          <button
            onClick={save}
            disabled={busy !== null || !form.exchange || !form.api_key || !form.api_secret}
            className="rounded px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            {busy === "save" ? "Saving…" : "Save credentials"}
          </button>
        </div>
      </section>

      {connections.length === 0 ? (
        <EmptyState title="No exchanges registered" hint="The adapter registry returned no exchanges." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {connections.map((c) => (
            <ConnectionCard
              key={c.exchange}
              conn={c}
              busy={busy}
              testResult={tests[c.exchange]}
              onTest={test}
              onDisconnect={(ex) => setConfirmDelete(ex)}
            />
          ))}
        </div>
      )}

      <section className="panel px-4 py-3 text-[11px] leading-relaxed opacity-70">
        <strong>Security guidance.</strong>
        <ul className="mt-1 list-inside list-disc space-y-1">
          {Object.entries(data?.guidance ?? {}).map(([k, v]) => (
            <li key={k}>
              <span className="opacity-60">{k.replace(/_/g, " ")}:</span> {v}
            </li>
          ))}
        </ul>
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Disconnect ${confirmDelete ?? ""}?`}
        detail="This deletes the stored API key and secret for your account. You can add them again at any time. Exchange-side keys are untouched — revoke them at the exchange if they are no longer needed."
        confirmLabel="Disconnect"
        busy={busy?.startsWith("del:") ?? false}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
    </div>
  );
}
