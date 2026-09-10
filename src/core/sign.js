import { createHmac } from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * ZebPay Futures request signing.
 *
 * The contract (futures/api-reference/authentication.md) is strict about *what*
 * gets signed:
 *
 *   GET / DELETE-with-query:
 *     `timestamp` is appended to the query parameters and the signature is taken
 *     over the query string **exactly as it will be transmitted**, preserving
 *     parameter order and URL encoding.
 *
 *   POST / PUT / PATCH / DELETE-with-body:
 *     `timestamp` is added at the root of the JSON body and the signature is
 *     taken over the **compact** serialization of that object. The exact same
 *     compact string must then be transmitted as the request body.
 *
 * Both cases are satisfied here by construction: the functions return the
 * signature *and* the payload they signed, so a caller cannot sign one string
 * and send another — which is the single most common cause of
 * `400 Invalid signature`.
 *
 * Output is lowercase hex, as the docs require.
 */

/**
 * HMAC-SHA256 over `data`, lowercase hex.
 * @param {string} secret
 * @param {string} data
 * @returns {string}
 */
export function hmacSha256Hex(secret, data) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ValidationError('API secret is required to sign a request');
  }
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

/**
 * Serialize a query-parameter object into a query string.
 *
 * Key order is the insertion order of `params` and is preserved verbatim, which
 * matters because the signature is taken over the resulting string. Values that
 * are `undefined` or `null` are dropped so callers can pass optional params
 * unconditionally.
 *
 * @param {Record<string, string|number|boolean|undefined|null>} params
 * @returns {string} query string without a leading `?`
 */
export function encodeQuery(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * Build a signed GET request.
 *
 * @param {object} args
 * @param {string} args.secret      API secret key
 * @param {number} args.timestamp   Unix ms; must be inside the server's auth window
 * @param {Record<string, any>} [args.params] query parameters, excluding `timestamp`
 * @returns {{ query: string, signature: string, signed: string, timestamp: number }}
 */
export function signGet({ secret, timestamp, params = {} }) {
  assertSafeTimestamp(timestamp);
  const query = encodeQuery({ ...params, timestamp });
  return {
    query,
    signed: query,
    signature: hmacSha256Hex(secret, query),
    timestamp,
  };
}

/**
 * Compact-JSON serialize a body, injecting `timestamp` at the root.
 *
 * `JSON.stringify` never emits insignificant whitespace, so its output is the
 * compact form the server re-derives before comparing signatures.
 *
 * @param {object} body
 * @param {number} timestamp
 * @returns {string}
 */
export function compactBody(body = {}, timestamp) {
  return JSON.stringify({ ...body, timestamp });
}

/**
 * Build a signed body-bearing request (POST / PUT / PATCH / DELETE-with-body).
 *
 * @param {object} args
 * @param {string} args.secret
 * @param {number} args.timestamp
 * @param {object} [args.body] request body, excluding `timestamp`
 * @returns {{ body: string, signature: string, signed: string, timestamp: number }}
 */
export function signBody({ secret, timestamp, body = {} }) {
  assertSafeTimestamp(timestamp);
  const payload = compactBody(body, timestamp);
  return {
    body: payload,
    signed: payload,
    signature: hmacSha256Hex(secret, payload),
    timestamp,
  };
}

/**
 * Build the Socket.IO `auth` object for the private WebSocket handshake.
 *
 * The signed payload is *only* `{"timestamp":<ms>}` — not the namespace URL, the
 * path, the API key, or any wrapper. For subaccounts the exact field order
 * `{"timestamp":...,"subaccountId":"..."}` must be signed, and `subaccountId` is
 * a **string** in both the payload and the handshake.
 *
 * @param {object} args
 * @param {string} args.secret
 * @param {number} args.timestamp
 * @param {string} [args.subaccountId]
 * @returns {{ auth: object, signed: string, signature: string, timestamp: number }}
 */
export function signSocketAuth({ secret, timestamp, subaccountId }) {
  assertSafeTimestamp(timestamp);
  const signed = subaccountId
    ? JSON.stringify({ timestamp, subaccountId: String(subaccountId) })
    : JSON.stringify({ timestamp });

  const auth = {
    clientType: 'api',
    apiKey: undefined, // filled by caller, which owns the key
    signature: hmacSha256Hex(secret, signed),
    timestamp,
  };
  if (subaccountId) auth.subaccountId = String(subaccountId);
  return { auth, signed, signature: auth.signature, timestamp };
}

/**
 * A timestamp must be a finite integer in **milliseconds**.
 *
 * Two failure modes are caught here rather than by the server:
 *   - seconds-resolution values (the classic `Date.now()/1000` mistake), which
 *     are otherwise plausible-looking integers and produce an opaque
 *     `400 Invalid or expired timestamp`
 *   - fractional or non-numeric values
 *
 * The lower bound is 2001-09-09 in milliseconds; any real request timestamp is
 * far above it, while a seconds-resolution value is ~1000x below.
 */
const MIN_PLAUSIBLE_MS = 1_000_000_000_000;

function assertSafeTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < MIN_PLAUSIBLE_MS) {
    throw new ValidationError(
      `timestamp must be a positive integer in milliseconds, received ${JSON.stringify(timestamp)}. ` +
        'If you are passing seconds, multiply by 1000.',
    );
  }
}
