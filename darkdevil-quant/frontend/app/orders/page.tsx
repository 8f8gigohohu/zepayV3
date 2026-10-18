import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Orders & Trade History · DarkDevil Quant" };

export default function OrdersPage() {
  return (
    <PlannedPage
      title="Orders & Trade History"
      milestone="MILESTONE 6"
      summary="There are no real orders and no fills to display: order placement is not implemented for any adapter, so the risk engine rejects every order attempt. Instead of an empty pretend table, this page states that plainly."
      blockedBy={[
        "No adapter implements place_order/cancel_order/order_history.",
        "No persistent order, fill or reconciliation records in the database.",
        "Binance signed endpoints cannot be exercised from this network (HTTP 451 geo-restriction).",
      ]}
      planned={[
        "Open orders, order detail, fills and trade history per account and market.",
        "Complete order lifecycle states: pending, partially filled, filled, rejected, cancelled, reconciliation required.",
        "Database-backed idempotency so a retry can never double-submit.",
        "Reconciliation after timeouts and restarts, surfacing unknown states honestly.",
        "Pre-trade confirmation showing exchange, market, side, quantity, price and estimated fees.",
      ]}
      safety="Every order attempt — including rejected and duplicate attempts — is already written to the append-only audit log, and live order routing stays disabled until adapter capability, risk checks, persistent records, idempotency and reconciliation are genuinely implemented and accepted."
    />
  );
}
