import { EventEmitter } from 'node:events';
import { ValidationError } from '../core/errors.js';
import { signSocketAuth } from '../core/sign.js';

/**
 * ZebPay Futures **private** WebSocket (Socket.IO, not raw WebSocket).
 *
 * Contract (futures/api-reference/websocket):
 *   - URL `https://sp-futuresws.zebpay.com`, namespace `/auth-stream`, path `/socket.io`
 *   - Credentials go in the Socket.IO `auth` handshake object — never in the URL
 *     or an event payload
 *   - API-key auth requires the `fetch:details` scope; `futures:trading` alone is
 *     rejected
 *   - The signed payload is exactly `{"timestamp":<ms>}`, or
 *     `{"timestamp":<ms>,"subaccountId":"<id>"}` for a subaccount
 *   - A fresh timestamp + HMAC must be generated before every connection attempt
 *   - Wait for `auth.ok` before treating the stream as live; `auth.error` means
 *     the service will disconnect
 *
 * Emits:
 *   `authenticated` — `auth.ok` received, safe to consume
 *   `auth-error`    — `auth.error` received (payload = reason)
 *   `event`         — `(name, data)` for every private event
 *   `disconnected`  — socket closed (payload = reason)
 *   `error`         — transport error
 *
 * The official samples do not reconnect. This client adds *opt-in* reconnect
 * with exponential backoff, re-signing on each attempt as the contract requires.
 */
export class PrivateStream extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]
   * @param {string} [opts.apiSecret]
   * @param {string} [opts.jwt]           alternative auth (web/API-token JWT)
   * @param {string} [opts.subaccountId]
   * @param {string} [opts.url]           defaults to the documented service URL
   * @param {boolean} [opts.autoReconnect]
   * @param {number} [opts.maxReconnectAttempts]
   * @param {(name:string,data:any)=>void} [opts.onEvent] convenience handler
   */
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey ?? '';
    this.apiSecret = opts.apiSecret ?? '';
    this.jwt = opts.jwt ?? '';
    this.subaccountId = opts.subaccountId ?? '';
    this.url = opts.url ?? 'https://sp-futuresws.zebpay.com';
    this.autoReconnect = opts.autoReconnect ?? false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.onEvent = opts.onEvent;

    this.socket = null;
    this.authenticated = false;
    this.attempt = 0;
    this.closed = false;
    this.#validate();

    // Transport failures are expected (reconnect backoff, dropped sockets). Node
    // rethrows an 'error' event with no listener, so default to a no-op and let
    // callers add their own handler if they want to observe them.
    this.on('error', () => {});
  }

  #validate() {
    const hasKey = Boolean(this.apiKey && this.apiSecret);
    if (!hasKey && !this.jwt) {
      throw new ValidationError(
        'PrivateStream needs an API key + secret (fetch:details scope) or a JWT',
      );
    }
  }

  /**
   * Build the handshake `auth` object, signing a freshly minted timestamp.
   * Exposed for tests so the exact signed bytes can be asserted.
   * @param {number} [now]
   */
  buildAuth(now = Date.now()) {
    if (this.jwt) {
      const auth = { clientType: 'api', token: this.jwt };
      if (this.subaccountId) auth.subaccountId = String(this.subaccountId);
      return { auth, signed: null, signature: null, timestamp: null };
    }
    const { auth, signed, signature, timestamp } = signSocketAuth({
      secret: this.apiSecret,
      timestamp: now,
      subaccountId: this.subaccountId,
    });
    auth.apiKey = this.apiKey;
    return { auth, signed, signature, timestamp };
  }

  /**
   * Connect. Resolves once `auth.ok` has been received.
   *
   * @param {object} [opts]
   * @param {(mod:any)=>any} [opts.ioFactory] injectable for tests; receives the
   *   `socket.io-client` module and must return a callable `io(url, opts)`
   * @param {number} [opts.timeoutMs] how long to wait for `auth.ok`
   * @returns {Promise<void>}
   */
  async connect({ ioFactory, timeoutMs = 15_000 } = {}) {
    if (this.closed) throw new ValidationError('stream has been closed');
    if (this.socket) throw new ValidationError('stream is already connected');

    const io = ioFactory ?? (await this.#loadIo());
    const { auth } = this.buildAuth();
    // Recommended namespace URL form: `${service}/auth-stream`
    const namespaceUrl = `${this.url.replace(/\/+$/, '')}/auth-stream`;

    const socket = io(namespaceUrl, {
      transports: ['websocket'],
      auth,
      reconnection: false, // we manage reconnects so we can re-sign each time
      timeout: timeoutMs,
    });
    this.socket = socket;
    this.attempt += 1;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for auth.ok after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAuthOk = () => {
        cleanup();
        this.authenticated = true;
        this.attempt = 0;
        this.emit('authenticated', { namespace: namespaceUrl });
        resolve();
      };
      const onAuthError = (err) => {
        cleanup();
        this.authenticated = false;
        this.emit('auth-error', err);
        reject(new Error(`private stream auth rejected: ${describe(err)}`));
      };
      const onConnectError = (err) => {
        cleanup();
        reject(new Error(`private stream connect failed: ${describe(err)}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off?.('auth.ok', onAuthOk);
        socket.off?.('auth.error', onAuthError);
        socket.off?.('connect_error', onConnectError);
      };

      socket.on('auth.ok', onAuthOk);
      socket.on('auth.error', onAuthError);
      socket.on('connect_error', onConnectError);
    });

    // After auth, wire the durable listeners.
    socket.onAny?.((name, data) => {
      this.emit('event', name, data);
      this.onEvent?.(name, data);
    });
    socket.on('disconnect', (reason) => {
      this.authenticated = false;
      this.socket = null;
      this.emit('disconnected', reason);
      if (this.autoReconnect && !this.closed) void this.#scheduleReconnect();
    });
    socket.on('connect_error', (err) => this.emit('error', err));

    return undefined;
  }

  async #scheduleReconnect() {
    if (this.attempt >= this.maxReconnectAttempts) {
      this.emit('error', new Error(`giving up after ${this.attempt} reconnect attempts`));
      return;
    }
    const delay = Math.min(500 * 2 ** this.attempt, 30_000);
    await new Promise((r) => setTimeout(r, delay));
    if (this.closed) return;
    try {
      await this.connect();
    } catch (err) {
      this.emit('error', err);
      if (!this.closed) void this.#scheduleReconnect();
    }
  }

  /** Close permanently; no reconnect will be scheduled. */
  close() {
    this.closed = true;
    this.authenticated = false;
    this.socket?.close?.();
    this.socket = null;
  }

  async #loadIo() {
    try {
      const mod = await import('socket.io-client');
      return mod.io ?? mod.default;
    } catch {
      throw new ValidationError(
        'socket.io-client is not installed. Run `npm install` or pass `ioFactory` to connect().',
      );
    }
  }
}

function describe(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  return err.message || err.data?.message || JSON.stringify(err);
}
