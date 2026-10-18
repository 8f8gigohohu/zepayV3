import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Strategies · DarkDevil Quant" };

export default function StrategiesPage() {
  return (
    <PlannedPage
      title="Strategies"
      milestone="MILESTONE 5"
      summary="There is no strategy registry yet. Strategies, their parameters and their version history are prerequisites for backtesting, paper trading and the controlled learning pipeline, so they are built before any execution path."
      blockedBy={[
        "No strategy engine or registry module exists in the backend.",
        "No experiment/version storage in the database.",
      ]}
      planned={[
        "Versioned strategy definitions with explicit parameters and defaults.",
        "Deterministic evaluation against historical candles with fees and slippage modelled.",
        "Per-strategy status: draft, validated, retired — with the evidence that justified each change.",
        "Comparison against the current production baseline before any promotion.",
        "Immutable record of which strategy version produced each decision.",
      ]}
      safety="Nothing on this page can submit an order. A strategy becomes eligible for live consideration only after out-of-sample and walk-forward validation plus explicit human approval, and live execution remains disabled until the adapter, risk and reconciliation criteria pass."
    />
  );
}
