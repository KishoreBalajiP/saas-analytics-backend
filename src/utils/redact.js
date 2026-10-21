/**
 * Secret redaction for logs, error reports and stored request paths
 * (roadmap 2.8; findings ops.13, ops2.04, api.08, GOV:log-redact).
 *
 * WHY IT EXISTS
 *   Credentials reach log lines in three shapes:
 *     1. inside URLs - the public embed read carries its bearer token as a
 *        path segment (`/embed/<token>`), inbound webhooks are addressed by
 *        a secret path token (`/webhooks/<token>`), and invitation preview,
 *        compliance status, password reset and email verification links carry
 *        `?token=` in the query string;
 *     2. inside free text - `Authorization: Bearer ...`, JWTs, connection
 *        strings with passwords in error messages and stacks;
 *     3. under well-known keys at any depth of a logged object
 *        (`{ req: { headers: { authorization } } }`, `{ body: { password } }`).
 *   Pino's path-based `redact` only covers the configured exact paths, and
 *   cannot touch message text, so this module does the rest.
 *
 * RESPONSIBILITY
 *   - `redactUrl(url)`       mask token path segments and sensitive query
 *                            values in one URL / path (morgan, error logs,
 *                            AccessLog rows).
 *   - `redactString(text)`   mask bearer tokens, JWTs, URL tokens, URI
 *                            credentials and session cookies anywhere in a
 *                            string (used on every serialised log line).
 *   - `redactDeep(value)`    copy an object, replacing values under
 *                            sensitive keys at any depth and running
 *                            `redactString` over every string.
 *   - `isSensitiveKey(key)`  the key rule shared by the logger and the error
 *                            reporter.
 *
 * DESIGN
 *   Pure functions with no imports, so the logger can use them without a
 *   module cycle. Replacements never contain quotes or backslashes, which
 *   keeps them safe to apply to an already-serialised JSON log line.
 */

export const REDACTED = '[REDACTED]';

/* ----------------------------- key matching ------------------------------ */

/** Normalised (lower-case, no `-`/`_`) key names that always hold secrets. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'jwt',
  'otp',
  'totp',
  'totpcode',
  'mfacode',
  'recoverycode',
  'recoverycodes',
  'privatekey',
  'encryptionkey',
  'signingsecret',
  'sessionid',
  'cardnumber',
  'cvv',
  'signature',
  'xsaassignature',
  'credentials',
  'connectionstring',
]);

/** Key suffixes that mark a secret (`resetToken`, `webhookSecret`, ...). */
const SENSITIVE_SUFFIXES = ['token', 'secret', 'password', 'passphrase', 'apikey'];

/**
 * Whether a property name holds a credential. Matching ignores case, `-` and
 * `_`, so `X-Api-Key`, `api_key` and `apiKey` are all caught.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE_KEYS.has(normalised)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/* ------------------------------ URL masking ------------------------------ */

/** Query parameter names (normalised) whose values are credentials. */
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'polltoken',
  'resettoken',
  'invitetoken',
  'invitationtoken',
  'verificationtoken',
  'embedtoken',
  'code',
  'key',
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'signature',
  'sig',
  'jwt',
  'otp',
  'auth',
  'session',
  'sessionid',
  'xamzsignature',
  'xamzcredential',
  'xamzsecuritytoken',
]);

function isSensitiveQueryKey(rawKey) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // keep the raw key
  }
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_QUERY_KEYS.has(normalised) || isSensitiveKey(key);
}

/**
 * Path segments that are secrets: the segment AFTER one of these markers.
 * `/embed/tokens/...` is the authenticated management surface (ids are not
 * secrets), so that one literal is exempt.
 */
const TOKEN_PATH_MARKERS = Object.freeze({
  embed: new Set(['tokens']),
  webhooks: new Set(),
});

const JWT_SEGMENT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;

function redactPath(path) {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1].toLowerCase();
    const segment = segments[i];
    if (!segment) continue;
    const exempt = TOKEN_PATH_MARKERS[previous];
    // `:token` is a route template parameter, not a value.
    if (exempt && !exempt.has(segment.toLowerCase()) && !segment.startsWith(':')) {
      segments[i] = REDACTED;
    } else if (JWT_SEGMENT.test(segment)) {
      segments[i] = REDACTED;
    }
  }
  return segments.join('/');
}

function redactQuery(query) {
  return query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      return isSensitiveQueryKey(key) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');
}

/**
 * Mask credentials in a URL or request path. Accepts absolute URLs
 * (`https://host/...`) and origin-relative paths (`/api/v1/...`). Values are
 * replaced verbatim (no re-encoding), so everything else stays byte-identical.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return url;
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  let path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? null : withoutHash.slice(queryIndex + 1);

  // Keep scheme://host intact; credentials in the authority are masked.
  const authority = path.match(/^([a-z][a-z0-9+.-]{0,31}:\/\/[^/]*)(.*)$/i);
  let prefix = '';
  if (authority) {
    prefix = authority[1].replace(/\/\/[^/@]*@/, `//${REDACTED}@`);
    path = authority[2];
  }

  const redacted = `${prefix}${redactPath(path)}${query === null ? '' : `?${redactQuery(query)}`}`;
  // A fragment can carry tokens too (OAuth implicit flow); never keep it.
  return hashIndex === -1 ? redacted : `${redacted}#${REDACTED}`;
}

/* ----------------------------- text masking ------------------------------ */

const QUERY_KEY_ALTERNATION =
  'token|access_token|refresh_token|id_token|pollToken|resetToken|inviteToken|invitationToken|verificationToken|embedToken|code|api_key|apiKey|apikey|secret|client_secret|password|signature|sig|jwt|otp|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token';

/** A path segment that names a source file (stack traces), not a token. */
const NOT_A_FILE = String.raw`(?![^/?#\s"'\\<>]*\.(?:js|mjs|cjs|ts|tsx|json|md)\b)`;

const TEXT_RULES = [
  // Authorization schemes followed by a credential. Bearer credentials are
  // long; a Basic credential is base64 (so it carries a digit, `+`, `/` or
  // `=`), which keeps prose such as "Basic authentication" readable.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g, `$1 ${REDACTED}`],
  // JSON Web Tokens anywhere (access tokens, impersonation tokens).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // `?token=...` / `&code=...` inside URLs embedded in text.
  [new RegExp(`([?&;](?:${QUERY_KEY_ALTERNATION})=)[^&#\\s"'\\\\<>]+`, 'gi'), `$1${REDACTED}`],
  // Public embed read and inbound webhook path tokens.
  // (`:param` route templates are not tokens.)
  [new RegExp(String.raw`(\/embed\/)(?!tokens(?:[/?#\s"'\\]|$))(?!:)${NOT_A_FILE}[^/?#\s"'\\<>]+`, 'gi'), `$1${REDACTED}`],
  [new RegExp(String.raw`(\/webhooks\/)(?!:)${NOT_A_FILE}[^/?#\s"'\\<>]+`, 'gi'), `$1${REDACTED}`],
  // scheme://user:password@host (MongoDB, Redis, SMTP URIs). Quantifiers
  // are bounded so a long run of letters can never cause quadratic
  // backtracking on a large log line (schemes are short, credentials too).
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^:/?#\s"'@]{0,256}:)[^@/?#\s"']{1,512}@/gi, `$1${REDACTED}@`],
  // Session cookies (`saas_session=...`, `saas_admin_session=...`, connect.sid).
  [/\b([A-Za-z0-9_.-]{0,48}(?:session|sid)[A-Za-z0-9_.-]{0,48})=([^;,\s"'\\]{8,})/gi, `$1=${REDACTED}`],
];

/**
 * Mask credentials that appear inside free text: authorization headers,
 * JWTs, URL token parameters and path tokens, URI passwords and session
 * cookies. Safe to run on a serialised JSON line.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactString(text) {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text;
  for (const [pattern, replacement] of TEXT_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/* ----------------------------- deep masking ------------------------------ */

const DEFAULT_MAX_DEPTH = 8;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactError(err, depth, ancestors, maxDepth) {
  const out = {
    type: err.name ?? 'Error',
    message: redactString(String(err.message ?? '')),
  };
  if (typeof err.stack === 'string') out.stack = redactString(err.stack);
  for (const key of Object.keys(err)) {
    if (key === 'message' || key === 'stack') continue;
    out[key] = isSensitiveKey(key) ? REDACTED : walk(err[key], depth + 1, ancestors, maxDepth);
  }
  return out;
}

function walkObject(value, depth, ancestors, maxDepth) {
  if (value instanceof Error) return redactError(value, depth, ancestors, maxDepth);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, ancestors, maxDepth));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      out[key] = isSensitiveKey(key) && item !== null && item !== undefined && typeof item !== 'boolean'
        ? REDACTED
        : walk(item, depth + 1, ancestors, maxDepth);
    }
    return out;
  }
  // Mongoose documents, ObjectIds and other classes: walk their JSON form so
  // a logged document cannot leak a password hash or secret field.
  let json;
  try {
    json = value.toJSON();
  } catch {
    return value;
  }
  return json === value ? value : walk(json, depth, ancestors, maxDepth);
}

function walk(value, depth, ancestors, maxDepth) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  // Dates, Buffers, typed arrays, Maps and Sets: serialised as-is.
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set) {
    return value;
  }
  const walkable = value instanceof Error || Array.isArray(value) || isPlainObject(value)
    || typeof value.toJSON === 'function';
  if (!walkable) return value;
  if (depth > maxDepth) return '[Truncated]';
  // Only a reference back to an ancestor is a cycle; the same object reached
  // twice through different keys is serialised twice.
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    return walkObject(value, depth, ancestors, maxDepth);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Copy `value`, replacing anything under a sensitive key (at any depth) with
 * `[REDACTED]` and running `redactString` over every string. Booleans and
 * nulls under sensitive keys are kept (`{ hasPassword: true }` is not a
 * secret). Cycles become `[Circular]`; nesting deeper than `maxDepth`
 * becomes `[Truncated]`. The input is never mutated.
 *
 * @template T
 * @param {T} value
 * @param {Object} [options]
 * @param {number} [options.maxDepth=8]
 * @returns {T}
 */
export function redactDeep(value, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  return walk(value, 0, new Set(), maxDepth);
}

export default { REDACTED, isSensitiveKey, redactUrl, redactString, redactDeep };
