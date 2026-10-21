/**
 * Storage service - the only public interface for the storage layer.
 *
 * WHY IT EXISTS
 *   Feature code must never import `@aws-sdk/client-s3`, `fs/promises` or
 *   the underlying storage driver directly. They call this service which:
 *     1. Resolves a driver lazily on first use.
 *     2. Adds a stable `storage:` key prefix so cross-feature collisions
 *        are impossible.
 *     3. Centralises observability and error handling.
 *
 * RESPONSIBILITY
 *   - Lazy driver resolution (local in dev, S3 when configured).
 *   - Thin pass-through to the driver with typed errors.
 *   - Lifecycle: `init()`, `close()`.
 *
 * DESIGN CONSTRAINTS
 *   - Driver is a singleton per process. Tests can call `reset()` to force
 *     a fresh driver (e.g. between test suites).
 *
 * HOW TO EXTEND
 *   Add a typed helper (e.g. `putJson(key, value)`) by composing the
 *   primitives below. Do not import the underlying driver in feature code.
 */

import crypto from 'node:crypto';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import { createStorage, STORAGE_PROVIDERS } from '../storage/index.js';

const KEY_PREFIX = 'storage/';

let driver = null;

/* -------------------------------- errors -------------------------------- */

/**
 * Typed error so callers can map storage failures to HTTP responses.
 */
export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.isOperational = true;
  }
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Initialise the storage driver if not already initialised. Idempotent.
 *
 * @returns {Object} the storage driver.
 */
export function init() {
  if (driver) return driver;
  const provider = env.storage.provider === STORAGE_PROVIDERS.S3 && env.storage.bucket
    ? STORAGE_PROVIDERS.S3
    : STORAGE_PROVIDERS.LOCAL;
  driver = createStorage({
    provider,
    baseDir: env.storage.baseDir,
    bucket: env.storage.bucket,
    region: env.storage.region,
    endpoint: env.storage.endpoint,
    accessKeyId: env.storage.accessKeyId,
    secretAccessKey: env.storage.secretAccessKey,
    forcePathStyle: env.storage.forcePathStyle,
  });
  return driver;
}

/**
 * Close the storage driver (releases the S3 client). Safe to call when
 * never initialised.
 *
 * @returns {Promise<void>}
 */
export async function close() {
  if (!driver) return;
  try {
    await driver.close?.();
  } finally {
    driver = null;
  }
}

/**
 * Return the underlying driver (lazy init).
 *
 * @returns {Object} the storage driver.
 */
export function getDriver() {
  return init();
}

/* ------------------------------- primitives ------------------------------ */

/**
 * Store a payload under the given key.
 *
 * @param {string} key
 * @param {Buffer|string|Object} data
 * @param {Object} [options]
 * @returns {Promise<{ key: string, size: number }>}
 */
export async function put(key, data, options) {
  return safe(() => init().put(prefixed(key), data, options));
}

/**
 * Read a stored object as a Buffer.
 *
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
export async function get(key) {
  return safe(() => init().get(prefixed(key)));
}

/**
 * Delete a stored object.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function del(key) {
  return safe(() => init().delete(prefixed(key)));
}

/**
 * Delete several stored objects (retention / purge helper). Deleting a key
 * that does not exist is not an error. Every key is attempted even when one
 * fails; the failures are reported, not thrown.
 *
 * @param {string[]} keys - service-level keys (as passed to `put`).
 * @returns {Promise<{ deleted: number, failed: Array<{ key: string, code: string }> }>}
 */
export async function delMany(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0))];
  let deleted = 0;
  const failed = [];
  for (const key of unique) {
    try {
      await del(key);
      deleted += 1;
    } catch (err) {
      failed.push({ key, code: err?.code ?? 'STORAGE_OPERATION_FAILED' });
    }
  }
  return { deleted, failed };
}

/**
 * Delete every stored object under a key prefix (e.g. a tenant's report
 * artefacts), up to `limit` objects per call.
 *
 * @param {string} prefix - service-level prefix, e.g. `reports/<tenantId>/`.
 * @param {Object} [options]
 * @param {number} [options.limit=1000]
 * @param {boolean} [options.dryRun=false] - only count what would be deleted.
 * @returns {Promise<{ matched: number, deleted: number, failed: number }>}
 */
export async function delPrefix(prefix, { limit = 1000, dryRun = false } = {}) {
  if (typeof prefix !== 'string' || prefix.replace(/\/+$/, '').length === 0) {
    // An empty prefix would match the whole bucket.
    throw new StorageError('INVALID_INPUT', 'delPrefix requires a non-empty prefix');
  }
  const listed = await list(prefix, { limit });
  const keys = listed.map((key) => (key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key));
  if (dryRun) return { matched: keys.length, deleted: 0, failed: 0 };
  const result = await delMany(keys);
  return { matched: keys.length, deleted: result.deleted, failed: result.failed.length };
}

/**
 * Check whether a key exists.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function exists(key) {
  return safe(() => init().exists(prefixed(key)));
}

/**
 * List keys under a prefix.
 *
 * @param {string} [prefix='']
 * @param {Object} [options]
 * @returns {Promise<string[]>}
 */
export async function list(prefix = '', options) {
  return safe(() => init().list(prefixed(prefix), options));
}

/**
 * Get a writable stream for a key. Use for large objects: write, `end()`,
 * then `await stream.completed` (resolves `{ key, size }` once the object
 * is stored; rejects when the write or upload failed).
 *
 * @param {string} key
 * @param {Object} [options] - { contentType, metadata }.
 * @returns {Promise<NodeJS.WritableStream & { completed: Promise<{ key: string, size: number }> }>}
 */
export async function createWriteStream(key, options) {
  return safe(() => init().createWriteStream(prefixed(key), options));
}

/**
 * Get a readable stream of a stored object.
 *
 * @param {string} key
 * @returns {Promise<NodeJS.ReadableStream>}
 */
export async function createReadStream(key) {
  return safe(() => init().createReadStream(prefixed(key)));
}

/**
 * Generate a (short-lived) signed URL for direct browser access.
 *
 * @param {string} key
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
export async function presignedUrl(key, options) {
  return safe(() => init().presignedUrl(prefixed(key), options));
}

/* --------------------------- signed downloads --------------------------- */

const DOWNLOAD_TOKEN_LABEL = 'storage-download-url:v1';
const SAFE_FILE_NAME_RE = /[^A-Za-z0-9._-]+/g;

/** HMAC key for download tokens, derived from the platform secret. */
function downloadTokenKey() {
  return crypto.createHmac('sha256', env.security.jwtSecret).update(DOWNLOAD_TOKEN_LABEL).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', downloadTokenKey()).update(payload).digest('base64url');
}

/**
 * A file name that is safe in a `Content-Disposition` header and on every
 * file system: letters, digits, `.`, `_` and `-` only.
 *
 * @param {string} name
 * @returns {string}
 */
export function safeFileName(name) {
  const cleaned = String(name ?? '').replace(SAFE_FILE_NAME_RE, '-').replace(/-+/g, '-').replace(/^[-.]+|-+$/g, '');
  return cleaned.slice(0, 150) || 'download';
}

/**
 * `Content-Disposition` value that makes a browser save the response.
 *
 * @param {string} [fileName]
 * @returns {string}
 */
export function attachmentDisposition(fileName) {
  return `attachment; filename="${safeFileName(fileName)}"`;
}

/**
 * Mint a short-lived signed URL that downloads one stored object with the
 * given file name and content type.
 *
 *   - S3: a presigned S3 GET URL (absolute) that sets the response
 *     Content-Type and Content-Disposition.
 *   - local: `<API_PREFIX>/files/<token>` served by `routes/file.routes.js`,
 *     where the token is an HMAC-signed grant for exactly this key that
 *     expires after `ttlSec`. The path is relative to the API origin.
 *
 * Callers authorise the request BEFORE minting (tenant + permission): the
 * URL itself is the credential until it expires.
 *
 * @param {string} key
 * @param {Object} [options] - { ttlSec, fileName, contentType }.
 * @returns {Promise<{ url: string, expiresAt: string }>}
 */
export async function signedDownloadUrl(key, { ttlSec = env.artifacts.downloadUrlTtlSec, fileName, contentType } = {}) {
  const ttl = Math.max(1, Math.floor(Number(ttlSec) || 0));
  const expiresAt = new Date(clock.now().getTime() + ttl * 1000);
  const driver = init();
  if (driver.provider === STORAGE_PROVIDERS.S3) {
    const url = await safe(() => driver.presignedUrl(prefixed(key), {
      ttlSec: ttl,
      contentType,
      contentDisposition: attachmentDisposition(fileName),
    }));
    return { url, expiresAt: expiresAt.toISOString() };
  }
  prefixed(key); // validates the key
  const payload = Buffer.from(JSON.stringify({
    k: key,
    e: Math.floor(expiresAt.getTime() / 1000),
    n: safeFileName(fileName),
    t: typeof contentType === 'string' ? contentType : null,
  })).toString('base64url');
  return { url: `${env.app.apiPrefix}/files/${payload}.${sign(payload)}`, expiresAt: expiresAt.toISOString() };
}

/**
 * Upload a local file without reading it into memory (backups: tenant
 * export archives). Drivers without a streaming `putFile` fall back to a
 * buffered `put`.
 *
 * @param {string} key
 * @param {string} filePath - absolute path of the local file.
 * @param {Object} [options] - { contentType, metadata }.
 * @returns {Promise<{ key: string, size: number }>}
 */
export async function putFile(key, filePath, options = {}) {
  return safe(async () => {
    const storage = init();
    if (typeof storage.putFile === 'function') return storage.putFile(prefixed(key), filePath, options);
    const { readFile } = await import('node:fs/promises');
    return storage.put(prefixed(key), await readFile(filePath), options);
  });
}

/**
 * Verify a download token minted by `signedDownloadUrl` (local storage).
 *
 * @param {string} token
 * @param {Date} [now]
 * @returns {{ key: string, fileName: string, contentType: string|null }|null}
 *   the grant, or null when the token is malformed, forged or expired.
 */
export function verifyDownloadToken(token, now = clock.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload), 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let grant;
  try {
    grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!grant || typeof grant.k !== 'string' || !grant.k || !Number.isFinite(grant.e)) return null;
  if (grant.e * 1000 < now.getTime()) return null;
  return { key: grant.k, fileName: safeFileName(grant.n), contentType: typeof grant.t === 'string' ? grant.t : null };
}

/* ----------------------------- typed helpers ---------------------------- */

/**
 * Store a JSON-serialisable object.
 *
 * @param {string} key
 * @param {*} value
 * @param {Object} [options]
 * @returns {Promise<{ key: string, size: number }>}
 */
export async function putJson(key, value, options = {}) {
  return put(key, JSON.stringify(value), { ...options, contentType: 'application/json' });
}

/**
 * Read and JSON-parse a stored object.
 *
 * @param {string} key
 * @returns {Promise<*>}
 */
export async function getJson(key) {
  const raw = await get(key);
  return JSON.parse(raw.toString('utf8'));
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Apply the service-level key prefix. Feature code never deals with prefixes.
 *
 * @param {string} key
 * @returns {string}
 */
function prefixed(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageError('INVALID_INPUT', 'storage key must be a non-empty string');
  }
  return KEY_PREFIX + key;
}

/**
 * Wrap a storage operation, normalising errors to `StorageError`.
 *
 * @param {() => Promise<any>} op
 * @returns {Promise<any>}
 */
async function safe(op) {
  try {
    return await op();
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError('STORAGE_OPERATION_FAILED', err?.message ?? 'Storage operation failed');
  }
}

export default {
  init,
  close,
  getDriver,
  put,
  get,
  del,
  delMany,
  delPrefix,
  exists,
  list,
  createWriteStream,
  createReadStream,
  presignedUrl,
  signedDownloadUrl,
  verifyDownloadToken,
  safeFileName,
  attachmentDisposition,
  putFile,
  putJson,
  getJson,
  StorageError,
  KEY_PREFIX,
};
