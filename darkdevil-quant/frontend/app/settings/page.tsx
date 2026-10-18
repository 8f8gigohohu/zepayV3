"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";

type Me = { id: number; email: string; role: string; created_at: string };

const HARDENED = [
  "Passwords hashed with bcrypt; session JWTs are held in HttpOnly, SameSite=Strict cookies and are never returned in JSON.",
  "State-changing cookie-authenticated requests require a double-submit CSRF token.",
  "Exchange API keys and secrets are encrypted at rest; never returned by any endpoint.",
  "Append-only audit trail with redaction of secret-bearing fields and role checks on mutations.",
  "Production requires a strong DJQ_SECRET_KEY and secure cookies (DJQ_COOKIE_SECURE=true).",
];

const NOT_YET = [
  "No rate limiting on authentication, credential or trading endpoints yet.",
  "Schema is created at startup; database migrations (Alembic) are not implemented yet.",
  "No KMS-backed credential encryption, server-side session revocation, or self-service account recovery.",
  "No dependency/secret scanning wired into a CI pipeline yet.",
];

export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  return (
    <div className="space-y-4">
      <header className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-base font-bold">Settings &amp; Security</h1>
        <StatusBadge tone="warn">PARTIAL</StatusBadge>
        <span className="text-xs opacity-60">no preference editing yet — this page reports the real posture</span>
      </header>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Account</h2>
        {!checked ? (
          <p className="mt-2 text-xs opacity-60">Checking session…</p>
        ) : me ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="opacity-50">Email</dt>
              <dd className="break-all">{me.email}</dd>
            </div>
            <div>
              <dt className="opacity-50">Role</dt>
              <dd>{me.role}</dd>
            </div>
            <div>
              <dt className="opacity-50">User id</dt>
              <dd>{me.id}</dd>
            </div>
            <div>
              <dt className="opacity-50">Registered</dt>
              <dd>{new Date(me.created_at).toLocaleString()}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs opacity-70">
            Not signed in. <Link className="underline" href="/login">Sign in</Link> or register the
            first account to become the platform admin.
          </p>
        )}
        {me && (
          <button
            onClick={() => {
              api<void>("/api/auth/logout", { method: "POST" })
                .catch(() => undefined)
                .finally(() => { window.location.href = "/login"; });
            }}
            className="mt-3 rounded border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--border)" }}
          >
            Sign out
          </button>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Security controls in place</h2>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-relaxed opacity-80">
            {HARDENED.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Known gaps (documented, not hidden)</h2>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-relaxed opacity-80">
            {NOT_YET.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel px-4 py-3 text-[11px] leading-relaxed opacity-70">
        <strong>Credential handling:</strong> API secrets are entered only on the Exchange
        Connections page, encrypted at rest, never returned by the API and never written to logs or
        audit details. Nothing in this chat, this UI or any endpoint will ever ask you for a seed
        phrase or private key.
      </section>
    </div>
  );
}
