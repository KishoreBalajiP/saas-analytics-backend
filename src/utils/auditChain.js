/**
 * Audit hash chain primitives (roadmap 2.5; finding gov.13).
 *
 * WHY IT EXISTS
 *   An append-only collection is only as trustworthy as the credentials that
 *   can write to it. The chain makes any edit, deletion or insertion after
 *   the fact detectable: each audit row stores the previous row's hash and a
 *   hash over its own canonical content, so changing one row breaks every
 *   link after it.
 *
 * HOW A ROW IS SEALED
 *   content = canonical JSON (sorted keys, `utils/auditPayload.canonicalJson`)
 *             of CHAIN_FIELDS, which include `seq` and `prevHash`
 *   hash    = SHA-256(content)                      when no key is configured
 *             HMAC-SHA-256(AUDIT_CHAIN_KEY, content) when a key is configured
 *   The first row ever written has `prevHash` = 64 zeros (GENESIS_HASH).
 *   With a key, `keyId` (first 12 hex of SHA-256 of the key) names the key so
 *   a verifier holding several keys (`AUDIT_CHAIN_PREVIOUS_KEYS`) picks the
 *   right one after a rotation.
 *
 * Pure functions only: the repository seals rows, the chain service
 * (`services/auditChain.service.js`) verifies them.
 */

import { createHash, createHmac } from 'node:crypto';
import env from '../config/env.js';
import { canonicalJson } from './auditPayload.js';

export const GENESIS_HASH = '0'.repeat(64);

/** The stored fields covered by the hash (everything except the hash data itself). */
export const CHAIN_FIELDS = Object.freeze([
  '_id', 'seq', 'prevHash', 'occurredAt', 'category', 'severity',
  'actorType', 'actorId', 'actorDisplay', 'tenantId', 'module', 'action',
  'resourceType', 'resourceId', 'before', 'after', 'metadata', 'reason',
  'ip', 'userAgent', 'requestId', 'result', 'errorCode',
]);

/** Short public identifier of a signing key (never the key itself). */
export function keyIdFor(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 12);
}

/**
 * The signing keys this process knows: the current key (used for new rows)
 * and any previous keys (verification only).
 *
 * @returns {{ current: { id: string, key: string }|null, byId: Map<string, string> }}
 */
export function signingKeys({
  current = env.audit?.chainKey ?? '',
  previous = env.audit?.chainPreviousKeys ?? [],
} = {}) {
  const byId = new Map();
  for (const key of [current, ...previous]) {
    if (typeof key === 'string' && key.length > 0) byId.set(keyIdFor(key), key);
  }
  return {
    current: current ? { id: keyIdFor(current), key: current } : null,
    byId,
  };
}

/**
 * Canonical content of a row (plain object or lean document).
 *
 * @param {Object} row
 * @returns {string}
 */
export function chainContent(row) {
  const picked = {};
  for (const field of CHAIN_FIELDS) {
    const value = row?.[field];
    picked[field] = value === undefined ? null : value;
  }
  return canonicalJson(picked);
}

/**
 * Hash canonical content with SHA-256, or HMAC-SHA-256 when `key` is given.
 *
 * @param {string} content
 * @param {string|null} [key]
 * @returns {string} 64 hex characters.
 */
export function hashContent(content, key = null) {
  if (key) return createHmac('sha256', key).update(content, 'utf8').digest('hex');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Seal a row: set `seq`, `prevHash`, `hashAlg`, `keyId` and `hash` on the
 * given target (a Mongoose document before save, or a plain object).
 *
 * @param {Object} target - document to seal (mutated).
 * @param {{ seq: number, hash: string }} head - the current chain head.
 * @param {Object} [opts]
 * @param {{ id: string, key: string }|null} [opts.signingKey]
 * @returns {{ seq: number, hash: string }} the new head.
 */
export function seal(target, head, { signingKey = signingKeys().current } = {}) {
  const seq = head.seq + 1;
  target.seq = seq;
  target.prevHash = head.hash;
  target.hashAlg = signingKey ? 'hmac-sha256' : 'sha256';
  target.keyId = signingKey ? signingKey.id : undefined;
  const plain = typeof target.toObject === 'function' ? target.toObject({ depopulate: true }) : target;
  const hash = hashContent(chainContent(plain), signingKey?.key ?? null);
  target.hash = hash;
  return { seq, hash };
}

/**
 * Recompute a stored row's hash.
 *
 * @param {Object} row - lean audit row.
 * @param {Map<string, string>} keysById
 * @returns {{ status: 'ok'|'mismatch'|'unverifiable', expected?: string }}
 */
export function checkRow(row, keysById = signingKeys().byId) {
  let key = null;
  if (row.hashAlg === 'hmac-sha256') {
    key = keysById.get(row.keyId) ?? null;
    if (!key) return { status: 'unverifiable' };
  }
  const expected = hashContent(chainContent(row), key);
  return expected === row.hash ? { status: 'ok' } : { status: 'mismatch', expected };
}

export default {
  GENESIS_HASH,
  CHAIN_FIELDS,
  keyIdFor,
  signingKeys,
  chainContent,
  hashContent,
  seal,
  checkRow,
};
