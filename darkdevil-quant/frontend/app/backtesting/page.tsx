import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Backtesting · DarkDevil Quant" };

export default function BacktestingPage() {
  return (
    <PlannedPage
      title="Backtesting"
      milestone="MILESTONE 5"
      summary="No backtest engine exists yet, so no historical performance numbers are shown anywhere in this application. Publishing simulated returns without a reproducible engine would be exactly the kind of fabricated result this project forbids."
      blockedBy={[
        "Historical candle ingestion and storage are not implemented.",
        "No deterministic evaluation loop, no fee/slippage model.",
        "No experiment storage, so results could not be reproduced or compared.",
      ]}
      planned={[
        "Historical candle ingestion with gap handling and explicit data-source labelling.",
        "Deterministic strategy evaluation with no look-ahead bias.",
        "Transaction fees, slippage and latency assumptions applied and always displayed.",
        "Train / validation / holdout separation plus walk-forward evaluation.",
        "Drawdown, exposure and stability metrics alongside return metrics.",
        "Reproducible runs: saved configuration, data range and engine version for every report.",
      ]}
      safety="Backtest output is research material, never a promise of future results. A candidate strategy must beat the current baseline on out-of-sample and walk-forward evaluation, survive transaction-cost stress testing and satisfy drawdown constraints before a human can approve promotion."
    />
  );
}
