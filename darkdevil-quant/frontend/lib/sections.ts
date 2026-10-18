export type SectionStatus = "live" | "partial" | "dev";

export type Section = {
  href: string;
  label: string;
  group: "Trade" | "Research" | "Accounts" | "Operations";
  status: SectionStatus;
  /** Short truthful note shown in the UI. */
  note: string;
};

/**
 * Single source of truth for navigation. `status` reflects what the backend can
 * actually do today - a page existing never implies the feature works.
 */
export const SECTIONS: Section[] = [
  { href: "/", label: "Dashboard", group: "Trade", status: "live", note: "system health + live public market data" },
  { href: "/markets", label: "Markets", group: "Trade", status: "live", note: "live tickers (REST polling)" },
  { href: "/orders", label: "Orders & Trades", group: "Trade", status: "dev", note: "no order routing implemented" },
  { href: "/portfolio", label: "Portfolio & Analytics", group: "Trade", status: "dev", note: "no account balances available" },
  { href: "/paper-trading", label: "Paper Trading", group: "Trade", status: "dev", note: "simulated exchange not built yet" },

  { href: "/ai-lab", label: "AI Trading Lab", group: "Research", status: "dev", note: "model adapter not implemented" },
  { href: "/strategies", label: "Strategies", group: "Research", status: "dev", note: "strategy registry not built yet" },
  { href: "/backtesting", label: "Backtesting", group: "Research", status: "dev", note: "backtest engine not built yet" },

  { href: "/exchanges", label: "Exchange Connections", group: "Accounts", status: "partial", note: "credential storage + read-only tests" },
  { href: "/wallets", label: "Wallets", group: "Accounts", status: "dev", note: "Phantom support not implemented" },

  { href: "/risk", label: "Risk Management", group: "Operations", status: "partial", note: "fail-closed engine, read-only view" },
  { href: "/activity", label: "Activity & Audit", group: "Operations", status: "dev", note: "audit table exists, no read API yet" },
  { href: "/system", label: "System Health", group: "Operations", status: "live", note: "health + exchange reachability" },
  { href: "/settings", label: "Settings & Security", group: "Operations", status: "partial", note: "account info + session" },
];

export const GROUP_ORDER: Section["group"][] = ["Trade", "Research", "Accounts", "Operations"];

export function statusTone(status: SectionStatus): "ok" | "warn" | "muted" {
  return status === "live" ? "ok" : status === "partial" ? "warn" : "muted";
}

export function statusLabel(status: SectionStatus): string {
  return status === "live" ? "LIVE" : status === "partial" ? "PARTIAL" : "PLANNED";
}
