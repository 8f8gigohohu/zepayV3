function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const entry = document.cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("djq_csrf="));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice("djq_csrf=".length));
  } catch {
    return null;
  }
}

export type Wrapped<T> = {
  exchange: string;
  endpoint: string;
  source_url: string;
  verified: string;
  ts_ms: number;
  upstream_ts_ms: number | null;
  stale_after_ms: number;
  age_ms: number;
  data: T;
};

/** Error that keeps the HTTP status so callers can distinguish 401 from 5xx. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  const res = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      /* keep statusText */
    }
    if (Array.isArray(detail)) {
      detail = detail.map((d: { msg?: string }) => d?.msg ?? String(d)).join("; ");
    }
    throw new ApiError(res.status, `${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function fmtNum(n: number | null | undefined, digits?: number) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const d = digits ?? (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 8);
  return n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function fmtAge(ms: number) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
