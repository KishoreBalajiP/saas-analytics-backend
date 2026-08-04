/**
 * Cryptographic utilities.
 *
 * WHY IT EXISTS
 *   Centralises all low-level crypto so future features (JWT, API keys,
 *   connector credential encryption) reuse audited primitives instead of
 *   re-implementing them ad hoc.
 *
 * RESPONSIBILITY
 *   - Generate UUIDs / secure random tokens.
 *   - Hash and verify sensitive values (deterministic SHA-256).
 *   - Encrypt/decrypt short secrets with AES-256-GCM using a key derived
 *     from the configured JWT secret.
 *
 * HOW TO EXTEND
 *   - Never roll your own crypto: extend this file with Node primitives only.
 *   - Keep derived keys stable per deployment (rotate carefully).
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import env from '../config/env.js';

/** Generate a namespaced UUID, e.g. `dash_8f4a...`. */
export function generateId(prefix = '') {
  return prefix ? `${prefix}_${uuidv4()}` : uuidv4();
}

/** Generate a cryptographically secure random token (hex). */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Deterministic SHA-256 hash (hex) - for values that must be comparable. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time equality to avoid timing attacks on sensitive comparisons. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Derive a 32-byte AES key from the configured secret.
 * Salted so the same env secret does not map to a trivially predictable key.
 */
function deriveKey() {
  return crypto.scryptSync(env.security.jwtSecret, 'saas-analytics', 32);
}

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt a short secret (e.g. a connector password). Returns a compact
 * `iv:tag:ciphertext` string. Primarily for future connector credentials.
 * NOTE: the higher-level credential contract is `utils/encryption.js`.
 */
export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

/** Decrypt a value produced by `encryptSecret`. */
export function decryptSecret(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid encrypted payload format');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
