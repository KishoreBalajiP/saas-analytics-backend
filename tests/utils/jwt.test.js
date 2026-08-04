/**
 * Tests for `utils/jwt.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, decode, parseExpiresIn, JwtError, JWT_AUDIENCES } from '../../src/utils/jwt.js';

test('parseExpiresIn handles common units', () => {
  assert.equal(parseExpiresIn('15s'), 15);
  assert.equal(parseExpiresIn('5m'), 5 * 60);
  assert.equal(parseExpiresIn('1h'), 60 * 60);
  assert.equal(parseExpiresIn('2d'), 2 * 60 * 60 * 24);
  assert.equal(parseExpiresIn('1w'), 7 * 60 * 60 * 24);
});

test('parseExpiresIn accepts seconds as number', () => {
  assert.equal(parseExpiresIn(120), 120);
});

test('parseExpiresIn rejects bad input', () => {
  assert.throws(() => parseExpiresIn('not-a-ttl'), /Invalid JWT TTL/);
  assert.throws(() => parseExpiresIn(0), /positive number/);
  assert.throws(() => parseExpiresIn(''), /non-empty/);
});

test('sign + verify round-trips a payload', async () => {
  const token = await sign({
    payload: { sub: 'usr_01H', roles: ['admin'] },
    audience: JWT_AUDIENCES.USER,
    expiresIn: '5m',
  });
  assert.equal(typeof token, 'string');
  const { payload } = await verify({ token, audience: JWT_AUDIENCES.USER });
  assert.equal(payload.sub, 'usr_01H');
  assert.deepEqual(payload.roles, ['admin']);
  assert.equal(payload.aud, JWT_AUDIENCES.USER);
});

test('verify rejects an expired token with EXPIRED code', async () => {
  const token = await sign({
    payload: { sub: 'usr_01H' },
    audience: JWT_AUDIENCES.USER,
    expiresIn: '1s',
  });
  // Wait > TTL plus the iat slack.
  await new Promise((r) => setTimeout(r, 1500));
  await assert.rejects(
    () => verify({ token, audience: JWT_AUDIENCES.USER }),
    (err) => err instanceof JwtError && err.code === 'EXPIRED',
  );
});

test('verify rejects the wrong audience with INVALID code', async () => {
  const token = await sign({
    payload: { sub: 'usr_01H' },
    audience: JWT_AUDIENCES.USER,
    expiresIn: '5m',
  });
  await assert.rejects(
    () => verify({ token, audience: JWT_AUDIENCES.ADMIN }),
    (err) => err instanceof JwtError,
  );
});

test('verify rejects an empty token', async () => {
  await assert.rejects(
    () => verify({ token: '' }),
    (err) => err instanceof JwtError && err.code === 'INVALID',
  );
});

test('decode returns the payload without verifying', () => {
  const fake = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature';
  const decoded = decode(fake);
  assert.deepEqual(decoded, { sub: 'x' });
});

test('decode returns null for malformed tokens', () => {
  assert.equal(decode('not-a-token'), null);
  assert.equal(decode('a.b'), null);
  assert.equal(decode(''), null);
  assert.equal(decode(null), null);
});

test('sign rejects empty payload', async () => {
  await assert.rejects(() => sign({ payload: null }), /plain object/);
  await assert.rejects(() => sign({ payload: 'x' }), /plain object/);
  await assert.rejects(() => sign({ payload: [] }), /plain object/);
});
