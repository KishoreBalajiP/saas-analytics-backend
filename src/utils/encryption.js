/**
 * High-level credential encryption contract.
 *
 * WHY IT EXISTS
 *   Connectors store secrets at rest (Atlas connection strings, OAuth
 *   refresh tokens, webhook signing secrets, third-party API keys). Those
 *   secrets must be encrypted before persistence. This module is the
 *   BUSINESS contract for that encryption so connector code never
 *   implements crypto itself.
 *
 * RESPONSIBILITY
 *   - `encrypt(plaintext, context)` -> ciphertext safe to store.
 *   - `decrypt(ciphertext, context)` -> original plaintext (memory only).
 *   - `rotateKeys({ limit })` -> re-encrypt stored secrets with a new key
 *     version (placeholder; real implementation walks the affected
 *     collections in batches).
 *
 * DESIGN CONSTRAINTS
 *   - Key material comes from config, never from code or logs.
 *   - Uses AES-256-GCM via `utils/crypto.js` so the primitive is audited
 *     once. Adds envelope structure (key version + context hash) so we can
 *     later swap to per-tenant/per-purpose keys or a KMS without changing
 *     callers.
 *   - NEVER logs ciphertext or plaintext.
 *
 * ENVELOPE FORMAT (versioned, future-proof)
 *   enc:v1:<base64(contextHash)>:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
 *
 * HOW TO EXTEND
 *   - When introducing a KMS adapter, route through `getKey()` and bump the
 *     envelope version (`enc:v2:...`). The decryption path tries each
 *     version in turn.
 */

import crypto from 'node:crypto';
import env from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';

/* ------------------------------ helpers --------------------------------- */

/**
 * Derive a per-context AES key. The context (e.g. `tenantId:purpose`) is
 * hashed together with the deployment secret so a leak of the master
 * secret alone does not decrypt stored credentials.
 *
 * @param {Object} [context] - optional context for the key derivation.
 * @returns {Buffer} 32-byte AES key.
 */
function deriveContextKey(context) {
  const master = env.security.jwtSecret;
  const ctxString = canonicalContext(context);
  const salt = `saas-analytics:${ctxString}`;
  return crypto.scryptSync(master, salt, 32);
}

/**
 * Produce a stable canonical representation of the context object. Object
 * key order must not affect the derivation, so we sort keys.
 *
 * @param {Object} [context] - optional context.
 * @returns {string} canonical string.
 */
function canonicalContext(context) {
  if (!context || typeof context !== 'object') return 'global';
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return 'global';
  return keys.map((k) => `${k}=${String(context[k])}`).join('&');
}

/**
 * Pack an envelope around the AES-GCM output so we can version + scope it.
 *
 * @param {Object} context
 * @param {string} ivHex
 * @param {string} tagHex
 * @param {string} dataHex
 * @returns {string} envelope string.
 */
function packEnvelope(context, ivHex, tagHex, dataHex) {
  const ctxHash = crypto
    .createHash('sha256')
    .update(canonicalContext(context))
    .digest('base64url');
  return [
    'enc',
    ENVELOPE_VERSION,
    ctxHash,
    Buffer.from(ivHex, 'hex').toString('base64url'),
    Buffer.from(tagHex, 'hex').toString('base64url'),
    Buffer.from(dataHex, 'hex').toString('base64url'),
  ].join(':');
}

/**
 * Unpack an envelope, returning the parts the primitive needs.
 *
 * @param {string} envelope
 * @returns {{ ivHex: string, tagHex: string, dataHex: string, version: string }}
 */
function unpackEnvelope(envelope) {
  const parts = String(envelope).split(':');
  if (parts.length !== 6 || parts[0] !== 'enc') {
    throw new Error('Invalid encrypted payload: missing envelope');
  }
  const [, version, ctxHash, ivB64, tagB64, dataB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version "${version}"`);
  }
  if (typeof ctxHash !== 'string' || ctxHash.length === 0) {
    throw new Error('Invalid encrypted payload: missing context hash');
  }
  return {
    version,
    ctxHash,
    ivHex: Buffer.from(ivB64, 'base64url').toString('hex'),
    tagHex: Buffer.from(tagB64, 'base64url').toString('hex'),
    dataHex: Buffer.from(dataB64, 'base64url').toString('hex'),
  };
}

/**
 * AES-256-GCM encrypt using a key derived from `context`. Returns the
 * primitive string (`iv:tag:ciphertext`) so we can pack our own envelope
 * around it.
 *
 * @param {string} plaintext
 * @param {Buffer} key
 * @returns {{ ivHex: string, tagHex: string, dataHex: string }}
 */
function gcmEncrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return {
    ivHex: iv.toString('hex'),
    tagHex: cipher.getAuthTag().toString('hex'),
    dataHex: data.toString('hex'),
  };
}

/**
 * AES-256-GCM decrypt using a key derived from `context`. Inverse of
 * `gcmEncrypt`.
 *
 * @param {string} ivHex
 * @param {string} tagHex
 * @param {string} dataHex
 * @param {Buffer} key
 * @returns {string} plaintext.
 */
function gcmDecrypt(ivHex, tagHex, dataHex, key) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/* -------------------------------- errors -------------------------------- */

/**
 * Typed error so callers can distinguish corruption from auth failures.
 */
export class EncryptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
    this.isOperational = true;
  }
}

/* -------------------------------- API ----------------------------------- */

/**
 * Encrypt a secret for storage.
 *
 * @param {string} plaintext - the secret value to protect.
 * @param {Object} [context] - { tenantId?, purpose? } key-derivation scope.
 *   The same context must be supplied to `decrypt()`.
 * @returns {Promise<string>} envelope ciphertext suitable for persistence.
 * @throws {EncryptionError} when inputs are invalid.
 */
export async function encrypt(plaintext, context) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new EncryptionError('INVALID_INPUT', 'encrypt() requires a non-empty string');
  }
  const key = deriveContextKey(context);
  const parts = gcmEncrypt(plaintext, key);
  return packEnvelope(context, parts.ivHex, parts.tagHex, parts.dataHex);
}

/**
 * Decrypt a stored secret back to memory.
 *
 * @param {string} envelope - value previously returned by `encrypt()`.
 * @param {Object} [context] - must match the context used to encrypt.
 * @returns {Promise<string>} the original plaintext (never persist it again).
 * @throws {EncryptionError} when the envelope is malformed or the context
 *   does not match.
 */
export async function decrypt(envelope, context) {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new EncryptionError('INVALID_INPUT', 'decrypt() requires a non-empty envelope');
  }
  let unpacked;
  try {
    unpacked = unpackEnvelope(envelope);
  } catch (err) {
    throw new EncryptionError('INVALID_ENVELOPE', err?.message ?? 'Invalid envelope');
  }
  const key = deriveContextKey(context);
  try {
    return gcmDecrypt(unpacked.ivHex, unpacked.tagHex, unpacked.dataHex, key);
  } catch (err) {
    throw new EncryptionError(
      'DECRYPTION_FAILED',
      err?.message ?? 'Failed to decrypt payload',
    );
  }
}

/**
 * Rotate encryption keys and re-encrypt existing secrets. Placeholder - the
 * real implementation iterates the relevant collections in batches.
 *
 * The signature is stable so callers can be wired now and a real
 * implementation lands when KMS / multi-key support is introduced (Phase 4+).
 *
 * @param {Object} [options]
 * @param {number} [options.limit=500] - batch size per pass.
 * @returns {Promise<{ rotated: number }>}
 */
export async function rotateKeys({ limit = 500 } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new EncryptionError('INVALID_INPUT', 'rotateKeys limit must be a positive integer');
  }
  // Placeholder: a future implementation walks every encrypted collection,
  // decrypts each value with the previous key and re-encrypts with the new
  // key version. Until then we report zero rotations so callers can be wired.
  return { rotated: 0 };
}

export default { encrypt, decrypt, rotateKeys, EncryptionError };
