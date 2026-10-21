/**
 * Recovery codes util (adminauth, roadmap 2.2; shared contract with
 * tenant-user MFA): generation, digest-only storage, single match,
 * normalisation of typed input. Also the human duration helper used in
 * auth emails (auth.15).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecoveryCodes,
  verifyRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  DEFAULT_RECOVERY_CODE_COUNT,
} from '../../src/utils/recoveryCodes.js';
import { describeDuration } from '../../src/utils/humanDuration.js';

const FORMAT = /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/;

test('generateRecoveryCodes returns unique formatted codes with matching digests', () => {
  const { codes, hashes } = generateRecoveryCodes(12);
  assert.equal(codes.length, 12);
  assert.equal(hashes.length, 12);
  assert.equal(new Set(codes).size, 12);
  for (let i = 0; i < codes.length; i += 1) {
    assert.match(codes[i], FORMAT);
    assert.match(hashes[i], /^[0-9a-f]{64}$/);
    assert.equal(hashes[i], hashRecoveryCode(codes[i]));
    assert.notEqual(hashes[i], codes[i]);
  }
});

test('generateRecoveryCodes falls back to the default count for bad input and caps large batches', () => {
  assert.equal(generateRecoveryCodes().codes.length, DEFAULT_RECOVERY_CODE_COUNT);
  assert.equal(generateRecoveryCodes(0).codes.length, DEFAULT_RECOVERY_CODE_COUNT);
  assert.equal(generateRecoveryCodes(-3).codes.length, DEFAULT_RECOVERY_CODE_COUNT);
  assert.equal(generateRecoveryCodes(1000).codes.length, 50);
});

test('verifyRecoveryCode returns the index of the matching digest, else -1', () => {
  const { codes, hashes } = generateRecoveryCodes(5);
  assert.equal(verifyRecoveryCode(codes[3], hashes), 3);
  assert.equal(verifyRecoveryCode(codes[0], hashes.slice(1)), -1, 'a removed (used) code no longer matches');
  assert.equal(verifyRecoveryCode('AAAA-BBBB-CCCC-DDDD', hashes), -1);
  assert.equal(verifyRecoveryCode('', hashes), -1);
  assert.equal(verifyRecoveryCode(codes[0], []), -1);
  assert.equal(verifyRecoveryCode(codes[0], null), -1);
  assert.equal(verifyRecoveryCode(codes[0], ['not-a-digest', 42, hashes[0]]), 2, 'malformed stored entries are skipped');
});

test('typed codes are normalised (case, spaces, dashes) and malformed input never hashes', () => {
  const { codes, hashes } = generateRecoveryCodes(1);
  const loose = ` ${codes[0].toLowerCase().replaceAll('-', ' ')} `;
  assert.equal(normalizeRecoveryCode(loose), codes[0].replaceAll('-', ''));
  assert.equal(verifyRecoveryCode(loose, hashes), 0);
  assert.equal(hashRecoveryCode('123456'), '', 'a TOTP-shaped value is not a recovery code');
  assert.equal(hashRecoveryCode('O0O0-I1I1-L1L1-0000'), '', 'look-alike symbols are not in the alphabet');
  assert.equal(hashRecoveryCode(null), '');
});

test('describeDuration states link lifetimes in words', () => {
  assert.equal(describeDuration(60 * 60 * 1000), '1 hour');
  assert.equal(describeDuration(24 * 60 * 60 * 1000), '1 day');
  assert.equal(describeDuration(72 * 60 * 60 * 1000), '3 days');
  assert.equal(describeDuration(15 * 60 * 1000), '15 minutes');
  assert.equal(describeDuration(90 * 1000), '2 minutes');
  assert.equal(describeDuration(0), 'a short time');
  assert.equal(describeDuration(Number.NaN), 'a short time');
});
