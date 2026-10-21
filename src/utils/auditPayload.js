/**
 * Audit payload serialisation and redaction (roadmap 2.5; findings gov.04,
 * gov.05, db.11).
 *
 * WHY IT EXISTS
 *   Everything that reaches the audit trail (`before`, `after`, `metadata`)
 *   must be plain, JSON-safe data with no secrets in it:
 *     - The old `redact()` walked every object with `Object.entries`, so a
 *       `Date` became `{}` and an `ObjectId` became a map of byte indexes.
 *       Timestamps and references were lost in every row and export.
 *     - Redaction matched a short list of exact key names, so credential
 *       hashes (`secretHash`, `tokenHash`), webhook tokens and similar
 *       fields were copied into the trail.
 *   This module is the one place that turns a value into what is stored. It
 *   is also what the tamper-evidence hash is computed over, so stored rows
 *   and hashed content can never disagree.
 *
 * RULES
 *   - Dates become ISO-8601 strings, ObjectIds 24-hex strings, Decimal128 its
 *     string form, binary data the marker `[binary]`; `undefined`, functions
 *     and symbols are dropped; NaN/Infinity become null.
 *   - Any key that looks like a credential (see `isSensitiveKey`) has its
 *     value replaced by `[REDACTED]`, at any depth. This is a second line of
 *     defence: model rows are first reduced to a per-model allow-list
 *     (`models/plugins/auditPolicy.js`).
 *   - Payloads are bounded (depth, keys, array items, string length) so a
 *     single row can never grow without limit.
 */

export const REDACTED = '[REDACTED]';
export const TRUNCATED = '[truncated]';

const MAX_DEPTH = 8;
const MAX_KEYS = 200;
const MAX_ARRAY_ITEMS = 200;
const MAX_STRING_LENGTH = 4000;

/** Exact (lower-cased) key names that always hold a credential. */
const SENSITIVE_EXACT = new Set([
  'password', 'passwd', 'secret', 'token', 'authorization', 'cookie', 'set-cookie',
  'apikey', 'api_key', 'x-api-key', 'privatekey', 'private_key', 'mfacode', 'otp', 'totp',
  'fingerprint', 'recoverycode', 'recoverycodes', 'signingsecret', 'webhooktoken',
  'refreshtoken', 'accesstoken', 'sessiontoken', 'clientsecret', 'mfasecret',
]);

/** Suffixes (lower-cased) that mark a credential-bearing key. */
const SENSITIVE_SUFFIXES = ['password', 'secret', 'hash', 'token', 'apikey'];

/**
 * True when a key name looks like it carries a credential (password, secret,
 * hash, token, API key, cookie, authorization header, MFA material).
 * `tokenId`, `apiKeyId` and similar identifiers are NOT sensitive.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT.has(lower)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isObjectId(value) {
  return value?._bsontype === 'ObjectId' || value?._bsontype === 'ObjectID';
}

function isBinary(value) {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  return value?._bsontype === 'Binary';
}

function truncateString(value) {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…${TRUNCATED}` : value;
}

/**
 * Turn any value into plain JSON-safe data (see module rules).
 *
 * @param {*} value
 * @param {Object} [opts]
 * @param {boolean} [opts.redact=true] - replace credential-like keys.
 * @param {boolean} [opts.limits=true] - apply the size bounds (depth, keys,
 *   array items, string length). Hashing turns them off so every stored
 *   byte is covered.
 * @returns {*} JSON-safe copy; `undefined` for values that are dropped.
 */
export function toAuditValue(value, { redact = true, limits = true } = {}) {
  return serialise(value, { redact, limits }, 0);
}

function serialise(value, opts, depth) {
  const { redact, limits } = opts;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (type === 'string') return limits ? truncateString(value) : value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return value.toString();

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (isObjectId(value)) return value.toHexString();
  if (value?._bsontype === 'Decimal128' || value?._bsontype === 'Long') return value.toString();
  if (isBinary(value)) return '[binary]';
  if (value instanceof RegExp) return value.toString();

  if (limits && depth >= MAX_DEPTH) return TRUNCATED;

  // Mongoose documents / subdocuments / arrays expose `toObject`.
  if (typeof value.toObject === 'function' && (value.$__ || value.isMongooseArray || value.isMongooseDocumentArray)) {
    return serialise(value.toObject({ depopulate: true, flattenMaps: true }), opts, depth);
  }

  if (Array.isArray(value)) {
    const source = limits ? value.slice(0, MAX_ARRAY_ITEMS) : value;
    const items = source.map((item) => {
      const out = serialise(item, opts, depth + 1);
      return out === undefined ? null : out;
    });
    if (limits && value.length > MAX_ARRAY_ITEMS) items.push(TRUNCATED);
    return items;
  }

  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  const out = {};
  let count = 0;
  for (const [rawKey, raw] of entries) {
    if (limits && count >= MAX_KEYS) {
      out[TRUNCATED] = true;
      break;
    }
    const key = String(rawKey);
    if (redact && isSensitiveKey(key)) {
      if (raw !== undefined) {
        out[key] = REDACTED;
        count += 1;
      }
      continue;
    }
    const serialised = serialise(raw, opts, depth + 1);
    if (serialised === undefined) continue;
    out[key] = serialised;
    count += 1;
  }
  return out;
}

/**
 * Deterministic JSON: object keys sorted at every level, values serialised
 * with `toAuditValue` (no redaction). Used to compare snapshots and to hash
 * audit rows.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(toAuditValue(value, { redact: false, limits: false }) ?? null));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Read a dotted path (`profile.name`) from a plain object. */
export function getPath(obj, path) {
  let current = obj;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Write a dotted path into a plain object, creating containers as needed. */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Keep only the allow-listed (dotted) paths of a snapshot.
 *
 * @param {Object|null} snapshot
 * @param {string[]} fields
 * @returns {Object|null}
 */
export function projectFields(snapshot, fields = []) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const out = {};
  for (const field of fields) {
    const value = getPath(snapshot, field);
    if (value !== undefined) setPath(out, field, value);
  }
  return out;
}

export default {
  REDACTED,
  isSensitiveKey,
  toAuditValue,
  canonicalJson,
  getPath,
  setPath,
  projectFields,
};
