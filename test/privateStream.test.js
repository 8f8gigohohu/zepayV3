import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PrivateStream } from '../src/ws/PrivateStream.js';
import { ValidationError } from '../src/core/errors.js';

const SECRET = 'test-secret-key';

/** Minimal Socket.IO client double: records the handshake and lets tests fire events. */
class FakeSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.anyEvents = [];
    this.closed = false;
  }

  onAny(fn) {
    this.anyHandlers ??= [];
    this.anyHandlers.push(fn);
  }

  fireAny(name, data) {
    for (const fn of this.anyHandlers ?? []) fn(name, data);
    this.anyEvents.push([name, data]);
  }

  close() {
    this.closed = true;
  }
}

function makeIoFactory({ failAuth = false, failConnect = false, delayMs = 0 } = {}) {
  const sockets = [];
  const io = (url, opts) => {
    const socket = new FakeSocket(url, opts);
    sockets.push(socket);
    setTimeout(() => {
      if (failConnect) socket.emit('connect_error', new Error('no route'));
      else if (failAuth) socket.emit('auth.error', { message: 'invalid credentials' });
      else socket.emit('auth.ok', {});
    }, delayMs);
    return socket;
  };
  io.sockets = sockets;
  return io;
}

test('PrivateStream requires credentials', () => {
  assert.throws(() => new PrivateStream({}), ValidationError);
  assert.throws(() => new PrivateStream({ apiKey: 'K' }), ValidationError, 'key without secret');
  assert.doesNotThrow(() => new PrivateStream({ apiKey: 'K', apiSecret: 'S' }));
  assert.doesNotThrow(() => new PrivateStream({ jwt: 'j' }));
});

test('buildAuth signs a fresh timestamp with the exact documented payload', () => {
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });
  const { auth, signed } = stream.buildAuth(1750000000000);

  assert.equal(signed, '{"timestamp":1750000000000}');
  assert.equal(auth.clientType, 'api');
  assert.equal(auth.apiKey, 'AK');
  assert.equal(auth.timestamp, 1750000000000);
  assert.match(auth.signature, /^[0-9a-f]{64}$/);
  assert.equal(auth.subaccountId, undefined);
});

test('buildAuth includes subaccountId in the signed payload and handshake', () => {
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET, subaccountId: 456 });
  const { auth, signed } = stream.buildAuth(1750000000000);

  assert.equal(signed, '{"timestamp":1750000000000,"subaccountId":"456"}');
  assert.equal(auth.subaccountId, '456');
});

test('buildAuth uses a JWT token when no key pair is configured', () => {
  const stream = new PrivateStream({ jwt: 'my-jwt' });
  const { auth, signed } = stream.buildAuth();
  assert.equal(auth.clientType, 'api');
  assert.equal(auth.token, 'my-jwt');
  assert.equal(signed, null, 'JWT handshakes are not HMAC-signed');
});

test('two connections produce different signatures because the timestamp is re-minted', () => {
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });
  const a = stream.buildAuth(1750000000000);
  const b = stream.buildAuth(1750000000001);
  assert.notEqual(a.signature, b.signature);
});

test('connect targets the /auth-stream namespace over the websocket transport', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });

  await stream.connect({ ioFactory: io });

  assert.equal(io.sockets.length, 1);
  assert.equal(io.sockets[0].url, 'https://sp-futuresws.zebpay.com/auth-stream');
  assert.deepEqual(io.sockets[0].opts.transports, ['websocket']);
  assert.equal(io.sockets[0].opts.reconnection, false, 'the client manages its own reconnects');
  assert.equal(stream.authenticated, true);
});

test('connect resolves on auth.ok and emits authenticated', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });
  const seen = [];
  stream.on('authenticated', (e) => seen.push(e));

  await stream.connect({ ioFactory: io });
  assert.equal(seen.length, 1);
  assert.match(seen[0].namespace, /\/auth-stream$/);
});

test('connect rejects on auth.error and reports the reason', async () => {
  const io = makeIoFactory({ failAuth: true });
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });
  const errors = [];
  stream.on('auth-error', (e) => errors.push(e));

  await assert.rejects(
    () => stream.connect({ ioFactory: io }),
    /auth rejected: invalid credentials/,
  );
  assert.equal(errors.length, 1);
  assert.equal(stream.authenticated, false);
});

test('connect rejects on a transport-level connect error', async () => {
  const io = makeIoFactory({ failConnect: true });
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });

  await assert.rejects(() => stream.connect({ ioFactory: io }), /connect failed/);
});

test('connect rejects if auth.ok never arrives', async () => {
  const io = (url, opts) => new FakeSocket(url, opts); // never emits
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });

  await assert.rejects(
    () => stream.connect({ ioFactory: io, timeoutMs: 30 }),
    /timed out waiting for auth\.ok/,
  );
});

test('private events are re-emitted and passed to onEvent', async () => {
  const io = makeIoFactory();
  const inline = [];
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET, onEvent: (n, d) => inline.push([n, d]) });
  const emitted = [];
  stream.on('event', (n, d) => emitted.push([n, d]));

  await stream.connect({ ioFactory: io });
  io.sockets[0].fireAny('newOrder', { orderId: 3133 });
  io.sockets[0].fireAny('liquidationAlert', { contractPair: 'BTCINR' });

  assert.deepEqual(emitted.map(([n]) => n), ['newOrder', 'liquidationAlert']);
  assert.deepEqual(inline[0], ['newOrder', { orderId: 3133 }]);
});

test('disconnect clears the authenticated flag and emits disconnected', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });
  const reasons = [];
  stream.on('disconnected', (r) => reasons.push(r));

  await stream.connect({ ioFactory: io });
  assert.equal(stream.authenticated, true);

  io.sockets[0].emit('disconnect', 'io server disconnect');
  assert.equal(stream.authenticated, false);
  assert.deepEqual(reasons, ['io server disconnect']);
  assert.equal(stream.socket, null);
});

test('close is permanent: no reconnect and further connects are refused', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET, autoReconnect: true });

  await stream.connect({ ioFactory: io });
  stream.close();

  assert.equal(stream.closed, true);
  assert.equal(io.sockets[0].closed, true);
  await assert.rejects(() => stream.connect({ ioFactory: io }), /has been closed/);
});

test('a second concurrent connect is refused', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({ apiKey: 'AK', apiSecret: SECRET });

  await stream.connect({ ioFactory: io });
  await assert.rejects(() => stream.connect({ ioFactory: io }), /already connected/);
});

test('the service URL is configurable and trailing slashes are trimmed', async () => {
  const io = makeIoFactory();
  const stream = new PrivateStream({
    apiKey: 'AK',
    apiSecret: SECRET,
    url: 'https://example.test///',
  });

  await stream.connect({ ioFactory: io });
  assert.equal(io.sockets[0].url, 'https://example.test/auth-stream');
});
