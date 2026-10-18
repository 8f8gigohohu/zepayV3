import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "AI Trading Lab · DarkDevil Quant" };

export default function AiLabPage() {
  return (
    <PlannedPage
      title="AI Trading Lab"
      milestone="MILESTONE 4"
      summary="No AI model adapter is implemented, so there are no AI analyses, decisions or predictions to show. This page deliberately displays nothing rather than inventing model output."
      blockedBy={[
        "Model adapter boundary and validated output schema are not written yet.",
        "Kronos license, checkpoints, dependencies and hardware requirements must be inspected before integration.",
        "No model inference service is configured (local or optional remote).",
      ]}
      planned={[
        "Structured, schema-validated decisions: action (HOLD/BUY/SELL/NO_TRADE), symbol, timeframe, confidence, reason_codes, evidence, risk_checks, strategy_version, model_version, created_at.",
        "Market analysis, trend/regime description and technical indicators derived from real candles only.",
        "Strategy explanations, risk and exposure analysis, decision history and strategy comparison.",
        "Backtest report summaries tied to reproducible experiment records.",
        "Model discovery, explicit load/readiness status, bounded inference timeouts, output normalisation and a clean disabled state when the model cannot load.",
      ]}
      safety="Confidence scores will be presented as model-reported values, never as guarantees of probability or profit. AI output can never bypass risk controls, alter credentials or reach exchange order endpoints: every idea must pass deterministic validation, portfolio checks, position sizing, data-freshness checks and the configured risk engine, with a safe fallback to NO_TRADE."
    />
  );
}
