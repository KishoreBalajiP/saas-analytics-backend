/**
 * Shared sensitive-field denylist for tenant dataset content.
 *
 * Connector rows are arbitrary customer data. Columns that carry credentials
 * (passwords, hashes, OTPs, reset / auth / refresh / push tokens, API keys,
 * secrets) must never surface through analytics, Ask, dashboards, reports,
 * exports or the external API. This module is the single rule used by:
 *   - ingestion (stripped before ConnectorRow is persisted)
 *   - the analytics engine (rejected in select/filter/groupBy/sort/metrics,
 *     stripped from raw rows and column lists)
 *   - schema discovery and the AI validator/context
 *
 * Matching is token based (camelCase / snake / kebab split) so innocent
 * analytics columns like `tokens_used`, `session_count`, `hashtag`
 * `password_reset_count`? (see below) stay usable while `fcm_token`,
 * `passwordHash`, `otp`, `api_key`, `client_secret` are blocked.
 */

const SENSITIVE_TOKENS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'pass',
  'hash', 'hashed', 'salt', 'otp', 'totp', 'mfa',
  'secret', 'secrets', 'token', 'fcm', 'apns',
  'apikey', 'credential', 'credentials', 'jwt', 'bearer', 'cookie', 'cvv',
]);

// Squashed (lowercase alnum-only) compound names.
const SENSITIVE_SQUASHED_RE = /(apikey|apisecret|privatekey|secretkey|accesskey|clientsecret|sessionid|sessiontoken|sessionkey|resetcode|resetlink|resettoken|resetkey|refreshtoken|accesstoken|authtoken|authkey|authcode|pushtoken|devicetoken|signingkey|encryptionkey|passwordhash|pwhash)/;

function tokenize(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when a dataset column/field name looks like a credential. */
export function isSensitiveFieldName(key) {
  if (typeof key !== 'string' || key === '') return false;
  // Nested path: any sensitive segment taints the whole path.
  if (key.includes('.')) return key.split('.').some(isSensitiveFieldName);
  const tokens = tokenize(key);
  if (tokens.some((t) => SENSITIVE_TOKENS.has(t))) return true;
  return SENSITIVE_SQUASHED_RE.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Return a copy of a row's data object without sensitive keys (recursive for
 * nested plain objects / arrays of objects). Non-objects are returned as is.
 */
export function stripSensitiveFields(value, depth = 0) {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripSensitiveFields(v, depth + 1));
  if (value instanceof Date || (value.constructor && value.constructor.name === 'ObjectId')) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveFieldName(k)) continue;
    out[k] = stripSensitiveFields(v, depth + 1);
  }
  return out;
}

/** Count sensitive keys (top level + nested) in a data object. */
export function sensitiveKeysIn(value, prefix = '', depth = 0, acc = []) {
  if (depth > 16 || value === null || typeof value !== 'object' || value instanceof Date) return acc;
  if (Array.isArray(value)) { value.forEach((v) => sensitiveKeysIn(v, prefix, depth + 1, acc)); return acc; }
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isSensitiveFieldName(k)) acc.push(path);
    else sensitiveKeysIn(v, path, depth + 1, acc);
  }
  return acc;
}

export default { isSensitiveFieldName, stripSensitiveFields, sensitiveKeysIn };
