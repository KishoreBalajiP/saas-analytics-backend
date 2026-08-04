/**
 * Encryption utility - HIGH-LEVEL credential encryption contract (placeholder).
 *
 * WHY IT EXISTS
 *   Connectors will store secrets at rest: MongoDB Atlas connection strings,
 *   Google OAuth tokens, webhook signing secrets, third-party API keys. Those
 *   secrets must be encrypted before they are persisted. This module is the
 *   contract for that encryption so connector code never implements crypto
 *   itself.
 *
 * RESPONSIBILITY (future)
 *   - `encrypt(payload, context)` -> ciphertext string safe to store.
 *   - `decrypt(ciphertext, context)` -> original plaintext (in memory only).
 *   - `rotateKeys()` -> re-encrypt all stored secrets with a new key version.
 *
 *   Design constraints for the future implementation:
 *   - Low-level primitives already exist in `utils/crypto.js` (AES-256-GCM,
 *     SHA-256, key derivation). This module should layer the *business rules*
 *     on top: key versioning, per-tenant/per-purpose keys, envelope
 *     encryption, and a clean swap path to a KMS (AWS KMS / GCP KMS) in
 *     production without changing callers.
 *   - NEVER log ciphertext or plaintext.
 *   - Key material comes from environment/config, never from code.
 *
 * HOW TO EXTEND
 *   This is intentionally NOT implemented (Phase 1.1 - architecture only).
 *   All functions FAIL CLOSED so no caller can accidentally persist a secret
 *   in plain text. Implement the three functions below when Phase 2 arrives
 *   and keep the signatures stable.
 */

/** Fail-closed error for every not-yet-implemented operation. */
function notImplemented(fn) {
  return new Error(`Encryption utility "${fn}" is not implemented yet (Phase 1.1 placeholder)`);
}

/**
 * Encrypt a secret for storage.
 *
 * @param {string} plaintext - the secret value to protect.
 * @param {Object} [context] - { tenantId?, purpose? } future: key derivation
 *   scope. Keep stable.
 * @returns {Promise<string>} ciphertext suitable for persistence.
 */
export async function encrypt(plaintext, context) {
  throw notImplemented('encrypt');
}

/**
 * Decrypt a stored secret back to memory.
 *
 * @param {string} ciphertext - value previously returned by `encrypt`.
 * @param {Object} [context] - must match the context used to encrypt.
 * @returns {Promise<string>} the original plaintext (never persist it again).
 */
export async function decrypt(ciphertext, context) {
  throw notImplemented('decrypt');
}

/**
 * Rotate encryption keys and re-encrypt existing secrets.
 *
 * @param {Object} [options] - future: { limit, cursor } for batching.
 * @returns {Promise<{rotated: number}>} count of secrets re-encrypted.
 */
export async function rotateKeys(options) {
  throw notImplemented('rotateKeys');
}
