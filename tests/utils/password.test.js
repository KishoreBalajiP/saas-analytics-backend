/**
 * Tests for `utils/password.js`.
 *
 * These run under whatever KDF the suite was started with (`PASSWORD_KDF`):
 * scrypt by default via `npm test`, real Argon2id via `npm run test:argon2`.
 * The generic contract must hold under both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import env from '../../src/config/env.js';
import { hash, verify, needsRehash } from '../../src/utils/password.js';

const kdf = env.security.kdf;
const prefix = kdf === 'scrypt' ? '$scrypt$' : '$argon2id$';

test('hash produces a PHC-formatted hash', async () => {
  const encoded = await hash('CorrectHorseBatteryStaple!');
  assert.equal(typeof encoded, 'string');
  assert.ok(encoded.startsWith(prefix), `expected ${prefix} envelope`);
});

test('verify accepts the original plaintext', async () => {
  const encoded = await hash('CorrectHorseBatteryStaple!');
  assert.equal(await verify('CorrectHorseBatteryStaple!', encoded), true);
});

test('verify rejects an incorrect plaintext', async () => {
  const encoded = await hash('CorrectHorseBatteryStaple!');
  assert.equal(await verify('WrongPassword', encoded), false);
});

test('verify treats malformed hashes as failures, not throws', async () => {
  assert.equal(await verify('anything', 'not-a-hash'), false);
  assert.equal(await verify('anything', ''), false);
});

test('hash rejects empty plaintext', async () => {
  await assert.rejects(() => hash(''), /non-empty string/);
  await assert.rejects(() => hash(null), /non-empty string/);
});

test('hash is deterministic for a given token and salt (refresh-token lookup)', async () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
  const salt = Buffer.alloc(32, 7);
  const first = await hash(token, salt);
  const second = await hash(token, salt);
  assert.equal(first, second, 'same token + salt must map to the same hash');
  assert.equal(await verify(token, first), true);
});

test('hash uses a fresh random salt when none is provided', async () => {
  const first = await hash('same-password');
  const second = await hash('same-password');
  assert.notEqual(first, second, 'identical plaintexts must not share a hash');
});

test('hash rejects salts outside the 8-64 byte range', async () => {
  await assert.rejects(() => hash('x', Buffer.alloc(4)), /salt/);
  await assert.rejects(() => hash('x', Buffer.alloc(65)), /salt/);
});

test('needsRehash is false for a current hash', async () => {
  const encoded = await hash('x');
  assert.equal(needsRehash(encoded), false);
});

test('needsRehash is true for legacy or non-current hashes', () => {
  assert.equal(needsRehash('$argon2i$v=19$m=4096,t=3,p=1$abc$def'), true);
  assert.equal(needsRehash('$scrypt$N=1024,r=8,p=1$abc$def'), true);
  assert.equal(needsRehash(''), true);
  assert.equal(needsRehash('bcrypt-hash'), true);
  assert.equal(needsRehash(null), true);
});
