import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactBody,
  encodeQuery,
  hmacSha256Hex,
  signBody,
  signGet,
  signSocketAuth,
} from '../src/core/sign.js';
import { ValidationError } from '../src/core/errors.js';

/**
 * Known-answer vectors generated with OpenSSL, independent of this codebase:
 *
 *   printf '<payload>' | openssl dgst -sha256 -hmac 'test-secret-key' -r
 *
 * Hard-coding them means a regression in the signing code fails these tests
 * rather than silently agreeing with itself.
 */
const SECRET = 'test-secret-key';

const VECTORS = {
  getQuery: {
    payload: 'symbol=BTCINR&timestamp=1712345678901',
    signature: 'eebbbeb08ed41935a11a8411cfff3e3a7d59c8a98f7032d2ca7fd2eb0c0a1520',
  },
  timestampOnly: {
    payload: 'timestamp=1712345678901',
    signature: 'c3009e25361ad68216ab507a8174925de7813d7dc82408d91fefe22a804b12d3',
  },
  body: {
    payload:
      '{"symbol":"BTCINR","amount":0.001,"side":"BUY","type":"MARKET","timestamp":1712345678901}',
    signature: '37c229a2241547519f3901a30171d49427da14609e74c3429416cfd3e70ceb90',
  },
  socket: {
    payload: '{"timestamp":1750000000000}',
    signature: '69debcc30abd6c8fa86ce5f98b061505c6bbfba1a2252a67160a024d5cb0c66a',
  },
  socketSubaccount: {
    payload: '{"timestamp":1750000000000,"subaccountId":"456"}',
    signature: '3c32d406c20c5ab4c35ef282a595e0ba09064719c048fc8d8282c69c4e1c9bd1',
  },
};

test('hmacSha256Hex matches OpenSSL known-answer vectors', () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    assert.equal(hmacSha256Hex(SECRET, v.payload), v.signature, `vector ${name}`);
  }
});

test('hmacSha256Hex emits lowercase hex of exactly 64 characters', () => {
  const sig = hmacSha256Hex(SECRET, 'anything');
  assert.match(sig, /^[0-9a-f]{64}$/);
});

test('hmacSha256Hex rejects a missing secret', () => {
  assert.throws(() => hmacSha256Hex('', 'data'), ValidationError);
  assert.throws(() => hmacSha256Hex(undefined, 'data'), ValidationError);
});

test('encodeQuery preserves insertion order and drops nullish values', () => {
  assert.equal(
    encodeQuery({ symbol: 'BTCINR', limit: 5, skip: undefined, also: null }),
    'symbol=BTCINR&limit=5',
  );
});

test('encodeQuery URL-encodes keys and values', () => {
  assert.equal(encodeQuery({ 'a b': 'c&d' }), 'a%20b=c%26d');
});

test('signGet signs exactly the transmitted query string, timestamp included', () => {
  const signed = signGet({ secret: SECRET, timestamp: 1712345678901, params: { symbol: 'BTCINR' } });

  assert.equal(signed.query, VECTORS.getQuery.payload);
  assert.equal(signed.signed, signed.query, 'signed bytes and transmitted bytes must be identical');
  assert.equal(signed.signature, VECTORS.getQuery.signature);
});

test('signGet with no params signs a timestamp-only query', () => {
  const signed = signGet({ secret: SECRET, timestamp: 1712345678901 });
  assert.equal(signed.query, VECTORS.timestampOnly.payload);
  assert.equal(signed.signature, VECTORS.timestampOnly.signature);
});

test('signGet preserves caller parameter order', () => {
  // Order matters: the server re-derives the signature from the received string.
  const a = signGet({ secret: SECRET, timestamp: 1712345678901, params: { symbol: 'BTCINR', limit: 5 } });
  const b = signGet({ secret: SECRET, timestamp: 1712345678901, params: { limit: 5, symbol: 'BTCINR' } });
  assert.equal(a.query, 'symbol=BTCINR&limit=5&timestamp=1712345678901');
  assert.equal(b.query, 'limit=5&symbol=BTCINR&timestamp=1712345678901');
  assert.notEqual(a.signature, b.signature, 'different order must produce a different signature');
});

test('signBody produces compact JSON with timestamp at the root', () => {
  const signed = signBody({
    secret: SECRET,
    timestamp: 1712345678901,
    body: { symbol: 'BTCINR', amount: 0.001, side: 'BUY', type: 'MARKET' },
  });

  assert.equal(signed.body, VECTORS.body.payload);
  assert.ok(!/\s/.test(signed.body), 'compact JSON must contain no insignificant whitespace');
  assert.equal(signed.signature, VECTORS.body.signature);
});

test('compactBody places timestamp last, matching insertion order', () => {
  assert.equal(
    compactBody({ a: 1 }, 1712345678901),
    '{"a":1,"timestamp":1712345678901}',
  );
});

test('signSocketAuth signs only the timestamp payload', () => {
  const { auth, signed, signature } = signSocketAuth({ secret: SECRET, timestamp: 1750000000000 });

  assert.equal(signed, VECTORS.socket.payload);
  assert.equal(signature, VECTORS.socket.signature);
  assert.equal(auth.clientType, 'api');
  assert.equal(auth.timestamp, 1750000000000);
  assert.equal(auth.subaccountId, undefined, 'no subaccountId for a root-account handshake');
});

test('signSocketAuth signs subaccountId in the documented field order', () => {
  const { auth, signed, signature } = signSocketAuth({
    secret: SECRET,
    timestamp: 1750000000000,
    subaccountId: 456,
  });

  assert.equal(signed, VECTORS.socketSubaccount.payload);
  assert.equal(signature, VECTORS.socketSubaccount.signature);
  assert.equal(auth.subaccountId, '456', 'subaccountId must be a string in the handshake');
});

test('signing rejects non-millisecond timestamps', () => {
  // Seconds-resolution is the classic mistake and yields "Invalid or expired timestamp".
  for (const bad of [1712345678, 1712345678901.5, NaN, 0, -1, '1712345678901', undefined]) {
    assert.throws(
      () => signGet({ secret: SECRET, timestamp: bad }),
      ValidationError,
      `expected rejection for ${String(bad)}`,
    );
  }
});
