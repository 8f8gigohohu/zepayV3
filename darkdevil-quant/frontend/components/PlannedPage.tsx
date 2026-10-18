import { DevStatusNotice } from "./States";
import StatusBadge from "./StatusBadge";

export default function PlannedPage({
  title,
  milestone,
  summary,
  planned,
  blockedBy,
  safety,
}: {
  title: string;
  milestone: string;
  summary: string;
  planned: string[];
  blockedBy?: string[];
  safety?: string;
}) {
  return (
    <div className="space-y-4">
      <header className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-base font-bold">{title}</h1>
        <StatusBadge tone="warn">{milestone}</StatusBadge>
        <StatusBadge tone="muted">NOT IMPLEMENTED</StatusBadge>
      </header>

      <DevStatusNotice
        milestone={milestone}
        status="This section is not implemented yet"
        detail={summary}
        blockedBy={blockedBy}
      />

      <section className="panel p-4">
        <h2 className="mb-2 text-sm font-semibold">Planned scope</h2>
        <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed opacity-75">
          {planned.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>

      {safety && (
        <section className="panel px-4 py-3 text-xs leading-relaxed opacity-70">
          <strong>Safety posture:</strong> {safety}
        </section>
      )}
    </div>
  );
}
