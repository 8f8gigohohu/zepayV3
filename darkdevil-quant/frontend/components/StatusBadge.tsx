export type StatusTone = "ok" | "warn" | "bad" | "muted";

export default function StatusBadge({
  tone = "muted",
  children,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
}) {
  const color =
    tone === "ok"
      ? "var(--up)"
      : tone === "bad"
      ? "var(--down)"
      : tone === "warn"
      ? "var(--warn)"
      : "var(--muted)";
  return (
    <span
      className="badge"
      style={{ color, borderColor: "var(--border)" }}
      aria-label={typeof children === "string" ? children : undefined}
    >
      {children}
    </span>
  );
}
