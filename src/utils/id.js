/**
 * ID generation utilities.
 *
 * WHY IT EXISTS
 *   Centralises every identifier the application generates. Using the same
 *   factory everywhere keeps IDs predictable, sortable where useful, and
 *   safe to expose in URLs / logs.
 *
 * RESPONSIBILITY
 *   - `uuid()` - RFC 4122 v4 UUID (random, not sortable).
 *   - `ulid()` - monotonic lexicographically-sortable identifier.
 *   - `nanoid(size)` - URL-safe random ID with configurable length.
 *   - `withPrefix(prefix, id)` - add a stable prefix (e.g. `usr_abc123`).
 *
 * DESIGN CONSTRAINTS
 *   - Every generator is cryptographically secure.
 *   - Prefixes are stable strings; never include variable data.
 *
 * HOW TO EXTEND
 *   Add a new generator when a feature needs a specific shape (e.g. short
 *   invite tokens). Keep the same signature pattern.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import env from '../config/env.js';

/**
 * Process-wide monotonic ULID factory. Monotonic ULIDs are strictly
 * sortable within the same process even when generated in the same
 * millisecond, which is desirable for primary keys (records sort by
 * creation time without an extra index).
 */
const monotonicUlid = monotonicFactory();

// URL-safe alphabet without ambiguous characters (no 0/O, 1/I/l).
const URL_SAFE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

/* ----------------------------- uuid ------------------------------------- */

/**
 * Generate an RFC 4122 v4 UUID. Random - NOT sortable.
 *
 * @returns {string} 36-character UUID (e.g. `f0e1...`).
 */
export function uuid() {
  return randomUUID();
}

/* ----------------------------- ulid ------------------------------------- */

/**
 * Generate a monotonic ULID (26 chars). Preferred over UUID for primary
 * keys so records sort naturally by creation time without an extra index.
 *
 * @returns {string} 26-character ULID.
 */
export function ulid() {
  return monotonicUlid();
}

/* --------------------------- prefixed ids -------------------------------- */

/**
 * Wrap an ID with a stable prefix so logs, URLs and error messages are
 * self-describing (`usr_01H...`, `t_01H...`, `con_01H...`).
 *
 * @param {string} prefix - the resource key (e.g. 'usr', 't', 'con').
 * @param {string} [id] - id to wrap; defaults to a fresh ULID.
 * @returns {string} `prefix_<id>`.
 */
export function withPrefix(prefix, id) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('withPrefix requires a non-empty prefix');
  }
  const value = id ?? ulid();
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('withPrefix requires a non-empty id');
  }
  return `${prefix}_${value}`;
}

/* --------------------------- short tokens ------------------------------- */

/**
 * Generate a short, URL-safe, cryptographically random token. Useful for
 * invitation links, password reset tokens, share tokens, embed tokens.
 *
 * @param {number} [size=24] - token length (in characters).
 * @returns {string} URL-safe random token.
 */
export function shortToken(size = 24) {
  if (!Number.isInteger(size) || size < 8 || size > 128) {
    throw new Error('shortToken size must be an integer between 8 and 128');
  }
  // We need more random bytes than characters because the alphabet is
  // smaller than 256; round up to the next integer to avoid bias.
  const byteCount = Math.ceil((size * 8) / 6);
  const bytes = randomBytes(byteCount);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += URL_SAFE_ALPHABET[bytes[i] % URL_SAFE_ALPHABET.length];
  }
  return out;
}

/* ------------------------- canonical prefixes --------------------------- */

/**
 * Canonical resource prefixes. Use these instead of inline strings so
 * renaming is a one-line change.
 */
export const PREFIXES = Object.freeze({
  USER: 'usr',
  ADMIN: 'adm',
  TENANT: 't',
  SESSION: 'ses',
  ROLE: 'rol',
  PERMISSION: 'prm',
  MODULE: 'mod',
  DASHBOARD: 'dash',
  REPORT: 'rpt',
  EMBED: 'emb',
  CONNECTOR: 'con',
  NOTIFICATION: 'ntf',
  AUDIT: 'aud',
  ACCESS: 'ac',
  COMPLIANCE: 'cmp',
  REFRESH: 'rt',
  INVITE: 'inv',
  RESET: 'rst',
});

/** Tenant id prefixed with the standard collection prefix from constants. */
export function tenantId() {
  return withPrefix(env.app.env === 'production' ? PREFIXES.TENANT : 't');
}

export default {
  uuid,
  ulid,
  withPrefix,
  shortToken,
  PREFIXES,
  tenantId,
};
