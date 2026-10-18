"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"register" | "login">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api<{ authenticated: boolean; role: string; email: string }>(
        `/api/auth/${mode}`,
        { method: "POST", body: JSON.stringify({ email, password }) });
      router.push("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-10 max-w-sm space-y-4">
      <div className="panel p-5">
        <h1 className="mb-1 text-lg font-bold">{mode === "login" ? "Sign in" : "Create account"}</h1>
        <p className="mb-4 text-xs opacity-60">
          The first registered account becomes the platform admin; later accounts are viewers.
        </p>
        <div className="space-y-3">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email"
            className="w-full rounded border px-3 py-2 text-sm"
            style={{ background: "var(--panel-2)", borderColor: "var(--border)" }} />
          <input value={password} onChange={(e) => setPassword(e.target.value)}
            type="password" placeholder="password (min 10 chars)"
            className="w-full rounded border px-3 py-2 text-sm"
            style={{ background: "var(--panel-2)", borderColor: "var(--border)" }} />
          {err && <p className="text-xs" style={{ color: "var(--down)" }}>{err}</p>}
          <button onClick={submit} disabled={busy || !email || !password}
            className="w-full rounded px-3 py-2 text-sm font-bold disabled:opacity-40"
            style={{ background: "var(--accent)" }}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Register"}
          </button>
        </div>
      </div>
      <button className="w-full text-center text-xs opacity-60 hover:opacity-100"
        onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "No account yet? Register" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
