/**
 * Error hierarchy for the ZebPay client.
 *
 * Every failure surfaces as one of these so callers can branch on `instanceof`
 * instead of parsing status codes out of messages.
 */

export class ZebpayError extends Error {
  /**
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, detail);
    // Preserve the server envelope verbatim — `customMessage` is often the only
    // human-readable explanation the API gives.
    if (detail.envelope) this.envelope = detail.envelope;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Thrown before a request is sent: bad arguments, missing credentials, bad config. */
export class ValidationError extends ZebpayError {}

/** The request was correctly formed but the server rejected it (4xx/5xx). */
export class ApiError extends ZebpayError {
  constructor(message, { status, envelope, path } = {}) {
    super(message, { status, envelope, path });
  }
}

/** 401/403 — bad signature, expired timestamp, wrong scope, IP not allowlisted. */
export class AuthError extends ApiError {}

/** 429 — the per-IP rate limit was hit. */
export class RateLimitError extends ApiError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.retryAfterMs = detail.retryAfterMs ?? null;
  }
}

/** Network / timeout / DNS failure — no HTTP status was ever received. */
export class TransportError extends ZebpayError {}

/** Live order placement was attempted while the kill switch was engaged. */
export class LiveTradingBlockedError extends ZebpayError {}

/**
 * Pick the most specific error class for an HTTP status.
 * @param {number} status
 */
export function errorClassFor(status) {
  if (status === 429) return RateLimitError;
  if (status === 401 || status === 403) return AuthError;
  return ApiError;
}
