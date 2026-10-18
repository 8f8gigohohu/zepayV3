import { fmtAge } from "@/lib/api";

export default function DataFreshness({
  ageMs,
  staleAfterMs,
  sourceUrl,
  endpoint,
  verified,
}: {
  ageMs: number;
  staleAfterMs: number;
  sourceUrl?: string;
  endpoint?: string;
  verified?: string;
}) {
  const stale = ageMs > staleAfterMs;
  return (
    <div className="text-xs leading-relaxed opacity-70">
      {sourceUrl && (
        <span>
          source: {sourceUrl}
          {endpoint ? ` · ${endpoint}` : ""}
        </span>
      )}
      <span style={{ color: stale ? "var(--warn)" : "var(--muted)" }}>
        {sourceUrl ? " · " : ""}fetched {fmtAge(ageMs)} ago
        {stale ? " · STALE (risk engine rejects orders on stale data)" : ""}
      </span>
      {verified && <span className="opacity-50"> · verified: {verified}</span>}
    </div>
  );
}
