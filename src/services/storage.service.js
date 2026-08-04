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

import env from '../config/env.js';
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
 * Get a writable stream for a key. Use for large objects.
 *
 * @param {string} key
 * @returns {Promise<NodeJS.WritableStream>}
 */
export async function createWriteStream(key) {
  return safe(() => init().createWriteStream(prefixed(key)));
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
  exists,
  list,
  createWriteStream,
  presignedUrl,
  putJson,
  getJson,
  StorageError,
  KEY_PREFIX,
};
