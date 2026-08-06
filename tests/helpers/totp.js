/**
 * TOTP test helper - RFC 6238 code generation with Node built-ins.
 *
 * WHY IT EXISTS
 *   MFA integration tests must mint valid 6-digit codes for the secret the
 *   API just enrolled. Implementing RFC 6238 here (HMAC-SHA1 + dynamic
 *   truncation + base32 decode) keeps the test independent of otplib's exact
 *   API surface while staying parameter-compatible with `mfa.service.js`
 *   (sha1, 30s period, 6 digits).
 */

import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode an RFC 4648 base32 string (no padding required).
 *
 * @param {string} input - uppercase base32 secret.
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Compute the current RFC 6238 TOTP code for a secret.
 *
 * @param {string} secret - base32 TOTP secret.
 * @param {Object} [opts]
 * @param {number} [opts.epoch=Date.now()] - reference epoch in ms.
 * @param {number} [opts.step=30] - time step in seconds.
 * @param {number} [opts.digits=6] - code length.
 * @returns {string} zero-padded code.
 */
export function totpCode(secret, { epoch = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(epoch / 1000 / step);
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export default { base32Decode, totpCode };
