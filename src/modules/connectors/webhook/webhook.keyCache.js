/**
 * Per-connector cache of decrypted webhook signing configuration.
 *
 * WHY IT EXISTS
 *   Decrypting a connector config derives an AES key with `scrypt`, which
 *   is deliberately CPU-expensive and synchronous. The webhook endpoint is
 *   public, so running that derivation on every request lets anyone holding
 *   a webhook URL burn the API's event loop. This cache keeps the decrypted
 *   webhook config (signing secret + legacy timestamp rule) in process
 *   memory for a short TTL, so a burst of requests - valid or forged - costs
 *   at most one derivation per connector per TTL.
 *
 * INVALIDATION
 *   - Entries are keyed by connector id AND a fingerprint of the stored
 *     (encrypted) config envelope, so a rotated secret is picked up on the
 *     next request even on another instance.
 *   - `invalidate(connectorId)` on update / delete; TTL
 *     (`WEBHOOK_KEY_CACHE_TTL_SECONDS`) and an LRU size bound otherwise.
 *
 * OBSERVABILITY
 *   `stats().derivations` counts how many times the loader (the key
 *   derivation) actually ran - tests use it to prove pre-checks run first.
 */

import crypto from 'node:crypto';
import env from '../../../config/env.js';

const MAX_ENTRIES = 1000;

/** @type {Map<string, { fingerprint: string, value: Object, expiresAt: number }>} */
const entries = new Map();
/** @type {Map<string, Promise<Object>>} */
const pending = new Map();
let derivations = 0;

function fingerprintOf(connector) {
  return crypto.createHash('sha256').update(String(connector?.config ?? '')).digest('base64url').slice(0, 22);
}

/**
 * Return the decrypted webhook config for `connector`, deriving it with
 * `load(connector)` only on a cache miss. Concurrent misses share one load.
 *
 * @param {Object} connector - lean connector doc (needs `_id` and `config`).
 * @param {(connector: Object) => Promise<Object>} load - decrypts the config.
 * @returns {Promise<Object>} frozen config object.
 */
export async function getWebhookConfig(connector, load) {
  const id = String(connector._id);
  const fingerprint = fingerprintOf(connector);
  const cacheKey = `${id}:${fingerprint}`;
  const now = Date.now();
  const hit = entries.get(id);
  if (hit && hit.fingerprint === fingerprint && hit.expiresAt > now) {
    entries.delete(id); // LRU touch
    entries.set(id, hit);
    return hit.value;
  }
  if (pending.has(cacheKey)) return pending.get(cacheKey);

  const promise = (async () => {
    derivations += 1;
    const value = Object.freeze({ ...(await load(connector)) });
    const ttlMs = Math.max(0, env.connectors.webhook.keyCacheTtlSeconds) * 1000;
    if (ttlMs > 0) {
      entries.delete(id);
      entries.set(id, { fingerprint, value, expiresAt: Date.now() + ttlMs });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    }
    return value;
  })();
  pending.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    pending.delete(cacheKey);
  }
}

/** Drop a connector's cached config (call on update / delete). */
export function invalidate(connectorId) {
  entries.delete(String(connectorId));
}

/** Drop everything (tests). */
export function clear() {
  entries.clear();
  pending.clear();
}

/** Cache metrics: `derivations` = number of loader (key-derivation) runs. */
export function stats() {
  return { derivations, size: entries.size };
}

export default { getWebhookConfig, invalidate, clear, stats };
