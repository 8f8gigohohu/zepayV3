import {
  ApiError,
  AuthError,
  RateLimitError,
  TransportError,
  ValidationError,
  errorClassFor,
} from './errors.js';
import { signBody, signGet } from './sign.js';

/**
 * HTTP transport for the ZebPay Futures REST API.
 *
 * Responsibilities, in order:
 *   1. Turn a method + path + params/body into a request whose *signed bytes*
 *      and *transmitted bytes* are guaranteed identical.
 *   2. Attach either JWT or API-key HMAC headers (or nothing, for public routes).
 *   3. Retry transient failures (429, 5xx, network) with exponential backoff +
 *      jitter, and never retry a request that was validly rejected.
 *   4. Unwrap the `{statusDescription, data, statusCode, customMessage}` envelope
 *      into either the `data` payload or a typed error.
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Methods whose signature is taken over a compact JSON body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export class HttpTransport {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable for tests
   * @param {(n?:number)=>number} [opts.random] injectable jitter source for tests
   * @param {(req:object)=>void} [opts.onRequest] observability hook
   * @param {typeof globalThis.fetch} [opts.fetch] injectable for tests
   * @param {number} [opts.backoffBaseMs]
   */
  constructor({
    baseUrl,
    timeoutMs = 10_000,
    maxRetries = 4,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
    onRequest,
    fetch: fetchImpl = globalThis.fetch,
    backoffBaseMs = 250,
  }) {
    if (!baseUrl) throw new ValidationError('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.sleep = sleep;
    this.random = random;
    this.onRequest = onRequest;
    this.fetch = fetchImpl;
    this.backoffBaseMs = backoffBaseMs;
  }

  /**
   * Exponential backoff with full jitter, capped at 10s.
   * Full jitter (rather than fixed doubling) avoids synchronized retry storms
   * when a shared per-IP rate limit trips for many concurrent callers.
   */
  backoffMs(attempt) {
    const capped = Math.min(this.backoffBaseMs * 2 ** attempt, 10_000);
    return Math.floor(capped * (0.5 + this.random() / 2));
  }

  /**
   * Perform a request.
   *
   * @param {object} req
   * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} req.method
   * @param {string} req.path                e.g. `/api/v1/market/orderBook`
   * @param {Record<string, any>} [req.query]
   * @param {object} [req.body]
   * @param {{type:'none'}} [req.auth]                 public route
   * @param {{type:'apiKey', apiKey:string, secret:string}} [req.auth]
   * @param {{type:'jwt', token:string}} [req.auth]
   * @param {string} [req.subaccountId]
   * @returns {Promise<any>} the unwrapped `data` field
   */
  async request({ method, path, query = {}, body, auth = { type: 'none' }, subaccountId }) {
    const upper = method.toUpperCase();
    const useBody = BODY_METHODS.has(upper) || (upper === 'DELETE' && body !== undefined);

    let url = `${this.baseUrl}${path}`;
    const headers = { Accept: 'application/json' };
    let payload;

    if (auth.type === 'apiKey') {
      const timestamp = Date.now();
      if (useBody) {
        const signed = signBody({ secret: auth.secret, timestamp, body });
        payload = signed.body;
        headers['x-auth-apikey'] = auth.apiKey;
        headers['x-auth-signature'] = signed.signature;
        headers['Content-Type'] = 'application/json';
      } else {
        const signed = signGet({ secret: auth.secret, timestamp, params: query });
        // The signed string IS the transmitted query — never rebuild it.
        url += signed.query ? `?${signed.query}` : '';
        headers['x-auth-apikey'] = auth.apiKey;
        headers['x-auth-signature'] = signed.signature;
      }
    } else if (auth.type === 'jwt') {
      headers.Authorization = `Bearer ${auth.token}`;
      if (useBody) payload = JSON.stringify(body ?? {});
      const qs = encodePlainQuery(useBody ? {} : query);
      if (qs) url += `?${qs}`;
      if (useBody) headers['Content-Type'] = 'application/json';
    } else {
      if (useBody) payload = JSON.stringify(body ?? {});
      const qs = encodePlainQuery(useBody ? {} : query);
      if (qs) url += `?${qs}`;
      if (useBody) headers['Content-Type'] = 'application/json';
    }

    if (subaccountId) headers.subaccountid = String(subaccountId);

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt - 1));
      // Inside the loop so observability sees every attempt, including retries.
      this.onRequest?.({ method: upper, path, auth: auth.type, url, attempt });
      try {
        const result = await this.#attempt({ method: upper, url, headers, payload, path });
        return result;
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof TransportError ||
          (err instanceof ApiError && RETRYABLE_STATUS.has(err.status) && !(err instanceof AuthError));
        if (!retryable || attempt === this.maxRetries) throw err;
      }
    }
    throw lastError;
  }

  /** Single HTTP round trip: send, check status, unwrap envelope. */
  async #attempt({ method, url, headers, payload, path }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : err?.message;
      throw new TransportError(`${method} ${path} failed: ${reason}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const envelope = tryParseJson(text);

    if (!res.ok) {
      const Klass = errorClassFor(res.status);
      const message = describeError(res.status, envelope, text);
      if (Klass === RateLimitError) {
        // The API sends no Retry-After; derive a hint only if one ever appears.
        const retryAfter = Number.parseFloat(res.headers?.get?.('retry-after') ?? '');
        throw new RateLimitError(message, {
          status: res.status,
          envelope,
          path,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
        });
      }
      throw new Klass(message, { status: res.status, envelope, path });
    }

    // Success: hand back `data` when the standard envelope is present, otherwise
    // the raw parsed body (some routes may not use the envelope).
    if (envelope && typeof envelope === 'object' && 'data' in envelope) {
      return envelope.data;
    }
    return envelope ?? text;
  }
}

function encodePlainQuery(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function tryParseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Build the most useful message available from the error envelope. */
function describeError(status, envelope, raw) {
  const custom = envelope?.customMessage;
  const detail =
    (Array.isArray(custom) && custom.filter(Boolean).join('; ')) ||
    envelope?.statusDescription ||
    (typeof envelope?.data === 'string' ? envelope.data : '') ||
    raw?.slice(0, 200) ||
    'no response body';
  return `HTTP ${status}: ${detail}`;
}

export { AuthError };
