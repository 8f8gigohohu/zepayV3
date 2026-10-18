import PlannedPage from "@/components/PlannedPage";

export const metadata = { title: "Wallets · DarkDevil Quant" };

export default function WalletsPage() {
  return (
    <PlannedPage
      title="Wallets"
      milestone="MILESTONE 5"
      summary="Self-custody wallet connectivity (Phantom first) is not implemented. Exchange accounts and on-chain wallets will remain separate surfaces with separate balances — they are never combined into one number, because double-counting the same funds would misstate your exposure."
      blockedBy={[
        "No wallet provider SDK is installed or configured in this repository.",
        "Supported networks and operations must be verified against the current Phantom provider before any UI claims support.",
        "Read-only balance sources must be chosen and configured (no fabricated balances).",
      ]}
      planned={[
        "Connect / disconnect Phantom; show shortened and full-copy public address.",
        "Display selected network and connection status, with explicit network-mismatch handling.",
        "Balances and token holdings only from a configured, reliable data source; otherwise shown as unavailable.",
        "Transaction history where a supported provider exists.",
        "Pre-signature review: network fees, exact amounts and destinations shown before approval.",
        "Explicit separation of read-only connection from transaction authorization.",
      ]}
      safety="The backend never custodies a wallet, never asks for a seed phrase or private key, and never signs or submits a transaction without explicit user approval. Wallet connection will never be treated as exchange API authentication, and wallet-based trading will not be claimed until a real transaction path plus confirmation handling is verified end to end."
    />
  );
}
