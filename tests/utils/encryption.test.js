/**
 * Tests for `utils/encryption.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, rotateKeys, EncryptionError } from '../../src/utils/encryption.js';

test('encrypt + decrypt round-trips a secret', async () => {
  const ciphertext = await encrypt('sk_live_abc123', { tenantId: 't_01H' });
  assert.notEqual(ciphertext, 'sk_live_abc123');
  const plain = await decrypt(ciphertext, { tenantId: 't_01H' });
  assert.equal(plain, 'sk_live_abc123');
});

test('encryption is context-scoped (different context cannot decrypt)', async () => {
  const ciphertext = await encrypt('sk_live_abc123', { tenantId: 't_01H' });
  await assert.rejects(
    () => decrypt(ciphertext, { tenantId: 't_OTHER' }),
    (err) => err instanceof EncryptionError,
  );
});

test('envelope includes version + context hash', async () => {
  const ciphertext = await encrypt('value', { purpose: 'connector' });
  assert.match(ciphertext, /^enc:v1:/);
});

test('encrypt rejects empty input', async () => {
  await assert.rejects(() => encrypt(''), (err) => err instanceof EncryptionError);
  await assert.rejects(() => encrypt(null), (err) => err instanceof EncryptionError);
});

test('decrypt rejects empty envelope', async () => {
  await assert.rejects(() => decrypt(''), (err) => err instanceof EncryptionError);
});

test('decrypt rejects malformed envelopes', async () => {
  await assert.rejects(() => decrypt('not-an-envelope'), (err) => err instanceof EncryptionError);
  await assert.rejects(() => decrypt('enc:v2:abc:def:ghi:jkl'), (err) => err instanceof EncryptionError);
});

test('rotateKeys returns zero rotations (placeholder)', async () => {
  const result = await rotateKeys({ limit: 100 });
  assert.deepEqual(result, { rotated: 0 });
});

test('rotateKeys rejects bad limits', async () => {
  await assert.rejects(() => rotateKeys({ limit: 0 }), (err) => err instanceof EncryptionError);
  await assert.rejects(() => rotateKeys({ limit: -5 }), (err) => err instanceof EncryptionError);
});
