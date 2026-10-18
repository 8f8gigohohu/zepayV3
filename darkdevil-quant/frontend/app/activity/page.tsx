import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Activity & Audit · DarkDevil Quant" };

export default function ActivityPage() {
  return (
    <PlannedPage
      title="Activity & Audit Log"
      milestone="MILESTONE 6"
      summary="The backend already writes an append-only audit trail for authentication, credential changes, kill-switch changes and every order attempt (allowed or rejected). What is missing is a read API and this viewer, so the records exist in the database but are not exposed through the UI yet."
      blockedBy={[
        "No read endpoint for the audit table (deliberately added only with pagination, filtering and access control).",
        "No filtering by actor, event or time range implemented.",
      ]}
      planned={[
        "Paginated, filterable audit viewer with actor, event type and time range.",
        "Explicit 'never logged' guarantees surfaced in the UI: passwords, API secrets, tokens and signatures are redacted by the backend before storage.",
        "Kill-switch, credential and order-decision events highlighted.",
        "Export for incident review and rotation audits.",
      ]}
      safety="The audit table is append-only by design: no update or delete path exists in the codebase, and secret-bearing field names are redacted on write. Nothing on this page can modify or erase an audit record."
    />
  );
}
