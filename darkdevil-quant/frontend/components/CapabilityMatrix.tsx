export default function CapabilityMatrix({
  caps,
}: {
  caps: Record<string, { status: string; detail: string }>;
}) {
  const color = (s: string) =>
    s === "verified_live"
      ? "var(--up)"
      : s === "not_implemented" || s === "unsupported"
      ? "var(--muted)"
      : s === "needs_verification" || s === "verified_docs"
      ? "var(--warn)"
      : "var(--muted)";
  const label = (s: string) => s.replace(/_/g, " ");
  return (
    <ul className="mt-2 space-y-1 text-[11px] leading-snug">
      {Object.entries(caps).map(([k, v]) => (
        <li key={k} className="flex gap-2">
          <span style={{ color: color(v.status) }}>{k}</span>
          <span className="opacity-70">{label(v.status)}</span>
          {v.detail && <span className="truncate opacity-40">{v.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
