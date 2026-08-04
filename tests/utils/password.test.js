/**
 * Tests for `utils/password.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, verify, needsRehash } from '../../src/utils/password.js';

test('hash produces a PHC-formatted argon2id string', async () => {
  const encoded = await hash('CorrectHorseBatteryStaple!');
  assert.equal(typeof encoded, 'string');
  assert.ok(encoded.startsWith('$argon2id$'), 'expected argon2id envelope');
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

test('needsRehash is false for a current argon2id hash', async () => {
  const encoded = await hash('x');
  assert.equal(needsRehash(encoded), false);
});

test('needsRehash is true for legacy or non-argon2id hashes', () => {
  assert.equal(needsRehash('$argon2i$v=19$m=4096,t=3,p=1$abc$def'), true);
  assert.equal(needsRehash(''), true);
  assert.equal(needsRehash('bcrypt-hash'), true);
  assert.equal(needsRehash(null), true);
});
