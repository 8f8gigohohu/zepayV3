import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Paper Trading · DarkDevil Quant" };

export default function PaperTradingPage() {
  return (
    <PlannedPage
      title="Paper Trading"
      milestone="MILESTONE 5"
      summary="The deterministic paper exchange does not exist yet. When it is built it will consume real market data but simulate orders, and every simulated fill will be labelled as simulated — never presented as a real exchange execution."
      blockedBy={[
        "No paper execution module or virtual ledger in the backend.",
        "No persistent order/fill records (required before simulated results mean anything).",
      ]}
      planned={[
        "Simulated order lifecycle: accepted, rejected, partially filled, filled, cancelled.",
        "Modelled fees, slippage, partial fills, rejection and latency assumptions — all visible in the UI.",
        "Virtual balances, positions, realised/unrealised P&L and an equity curve.",
        "Explicit SIMULATED banner on every panel and every record.",
        "Same risk engine and pre-trade checks as a live order would face.",
      ]}
      safety="Paper mode is a distinct mode with a permanent visual marker; the system will never silently switch from paper to live. Simulated numbers are never mixed with real account data."
    />
  );
}
