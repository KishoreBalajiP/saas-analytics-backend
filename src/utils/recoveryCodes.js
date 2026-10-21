/**
 * MFA recovery codes (roadmap 2.2; shared with tenant-user MFA).
 *
 * PURPOSE
 *   One-time backup codes that stand in for a TOTP code when the
 *   authenticator is lost. Generated in a batch at enrolment (and on an
 *   explicit regeneration), shown to the user exactly once, and stored only
 *   as digests.
 *
 * CONTRACT (parallel build contract "Recovery codes", owner: adminauth)
 *   - generateRecoveryCodes(count) -> { codes: string[], hashes: string[] }
 *     (`hashes[i]` is the digest of `codes[i]`).
 *   - verifyRecoveryCode(code, hashes) -> index of the matching digest, or -1.
 *   Callers persist `hashes` and remove the matched digest atomically when a
 *   code is used, so every code works once.
 *
 * SECURITY
 *   - Each code is 16 characters from a 31-symbol alphabet (about 79 bits
 *     of entropy) drawn with `crypto.randomInt`, so a plain SHA-256 digest is
 *     enough at rest: brute-forcing a leaked digest is infeasible, and a
 *     per-code KDF would make every login try up to `count` slow hashes.
 *   - The alphabet drops look-alike symbols (0/O, 1/I/L) and input is
 *     normalised (case, spaces and dashes ignored) so a code typed from
 *     paper still matches.
 *   - Digests are compared with `timingSafeEqual` across the whole list.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** 31 symbols: upper-case letters and digits without 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP_COUNT = 4;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUP_COUNT * GROUP_LENGTH;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** Default batch size when the caller does not pass one. */
export const DEFAULT_RECOVERY_CODE_COUNT = 10;

/**
 * Canonical form of a typed code: upper case, no spaces or dashes.
 *
 * @param {string} code
 * @returns {string}
 */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * SHA-256 digest (hex) of a recovery code, or '' when the input cannot be a
 * recovery code (wrong length or symbols).
 *
 * @param {string} code
 * @returns {string}
 */
export function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  if (!CODE_RE.test(normalized)) return '';
  return createHash('sha256').update(`mfa-recovery:${normalized}`, 'utf8').digest('hex');
}

/** One random code formatted as `XXXX-XXXX-XXXX-XXXX`. */
function randomCode() {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += ALPHABET[randomInt(ALPHABET.length)];
  const groups = [];
  for (let i = 0; i < CODE_LENGTH; i += GROUP_LENGTH) groups.push(raw.slice(i, i + GROUP_LENGTH));
  return groups.join('-');
}

/**
 * Generate a batch of unique recovery codes and their digests.
 *
 * @param {number} [count=DEFAULT_RECOVERY_CODE_COUNT] - 1..50.
 * @returns {{ codes: string[], hashes: string[] }}
 */
export function generateRecoveryCodes(count = DEFAULT_RECOVERY_CODE_COUNT) {
  const n = Number.isInteger(count) && count > 0 ? Math.min(count, 50) : DEFAULT_RECOVERY_CODE_COUNT;
  const codes = [];
  const hashes = [];
  const seen = new Set();
  while (codes.length < n) {
    const code = randomCode();
    const digest = hashRecoveryCode(code);
    if (seen.has(digest)) continue;
    seen.add(digest);
    codes.push(code);
    hashes.push(digest);
  }
  return { codes, hashes };
}

/**
 * Find the stored digest a typed code matches.
 *
 * @param {string} code - the code as typed by the user.
 * @param {string[]} hashes - stored digests (unused codes only).
 * @returns {number} the index in `hashes`, or -1 when nothing matches.
 */
export function verifyRecoveryCode(code, hashes) {
  const digest = hashRecoveryCode(code);
  if (!digest || !Array.isArray(hashes) || hashes.length === 0) return -1;
  const candidate = Buffer.from(digest, 'hex');
  let match = -1;
  hashes.forEach((stored, index) => {
    if (typeof stored !== 'string' || stored.length !== digest.length) return;
    const buf = Buffer.from(stored, 'hex');
    if (buf.length === candidate.length && timingSafeEqual(buf, candidate) && match === -1) match = index;
  });
  return match;
}

export default {
  DEFAULT_RECOVERY_CODE_COUNT,
  normalizeRecoveryCode,
  hashRecoveryCode,
  generateRecoveryCodes,
  verifyRecoveryCode,
};
