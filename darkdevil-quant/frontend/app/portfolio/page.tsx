import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Portfolio & Analytics · DarkDevil Quant" };

export default function PortfolioPage() {
  return (
    <PlannedPage
      title="Portfolio & Analytics"
      milestone="MILESTONE 6"
      summary="No balances, positions or performance series are available: the private account-read path exists in code but has not been verified against a live account, and no balances have been read. This page shows nothing rather than showing zeros that would look like a real empty portfolio."
      blockedBy={[
        "Account-balance reads are unverified (Binance signed endpoints are geo-blocked from this network).",
        "ZebPay private authentication is not implemented (official docs incomplete).",
        "No position or P&L ledger exists.",
      ]}
      planned={[
        "Per-exchange balances with the source and timestamp of every figure.",
        "Open positions and exposure, separated by exchange account.",
        "Realised/unrealised P&L and an equity curve built from recorded fills.",
        "Performance analytics over configurable windows, with the data range stated.",
        "Explicit 'unavailable' states instead of placeholder numbers when a source cannot be read.",
      ]}
      safety="Exchange balances and (later) on-chain wallet balances are never merged into a single number without labelling the source, because the same funds can otherwise be counted twice. Analytics will only ever be computed from persisted, auditable records."
    />
  );
}
