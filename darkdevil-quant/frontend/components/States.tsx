export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div
      className="panel px-4 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-semibold opacity-80">{title}</p>
      {hint && <p className="mt-1 text-xs opacity-60">{hint}</p>}
    </div>
  );
}

export function ErrorState({
  title = "Something failed",
  detail,
  onRetry,
  actionHint,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
  actionHint?: string;
}) {
  return (
    <div
      className="panel px-4 py-4"
      style={{ borderColor: "var(--down)" }}
      role="alert"
    >
      <p className="text-sm font-semibold" style={{ color: "var(--down)" }}>
        {title}
      </p>
      {detail && <p className="mt-1 break-words text-xs opacity-80">{detail}</p>}
      {actionHint && <p className="mt-1 text-xs opacity-60">{actionHint}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded px-3 py-1.5 text-xs font-semibold"
          style={{ background: "var(--accent)" }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel space-y-2 p-4" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded"
          style={{ background: "var(--panel-2)", opacity: 0.7 - i * 0.12 }}
        />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/**
 * Honest development-status notice for pages whose backend capability is not
 * implemented yet. Never renders simulated data - it only states the truth.
 */
export function DevStatusNotice({
  milestone,
  status,
  detail,
  blockedBy,
}: {
  milestone: string;
  status: string;
  detail: string;
  blockedBy?: string[];
}) {
  return (
    <div className="panel px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{status}</span>
        <span className="badge" style={{ color: "var(--warn)" }}>
          {milestone}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed opacity-70">{detail}</p>
      {blockedBy && blockedBy.length > 0 && (
        <ul className="mt-3 list-inside list-disc space-y-1 text-[11px] opacity-60">
          {blockedBy.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] opacity-50">
        This page intentionally shows no simulated values. Nothing here is
        enabled until the underlying capability is implemented and verified.
      </p>
    </div>
  );
}
