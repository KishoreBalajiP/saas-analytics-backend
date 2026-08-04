/**
 * Local filesystem storage driver.
 *
 * WHY IT EXISTS
 *   Default storage for development/tests and small deployments: files
 *   live under a configurable base directory (e.g. the `uploads/` folder).
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `StorageDriver` surface as every
 *   other provider. Files are stored on the local filesystem; keys are
 *   sanitized to prevent path traversal.
 *
 * DRIVER SURFACE (documented, shared by all providers):
 *   - put(key, data, options)        -> Promise<{ key }>
 *   - get(key)                       -> Promise<Buffer>
 *   - delete(key)                    -> Promise<void>
 *   - exists(key)                    -> Promise<boolean>
 *   - list(prefix, options)          -> Promise<string[]>
 *   - createWriteStream(key)         -> Promise<NodeJS.WritableStream>
 *   - presignedUrl(key, options)     -> Promise<string>
 *   - close()                        -> Promise<void>
 *
 * CONFIG:
 *   { provider: 'local', baseDir: 'uploads', createDirs: true }
 *
 * HOW TO EXTEND
 *   Replace the implementation with a streaming helper if needed. Always
 *   sanitize keys (no `..`, no leading `/`).
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

const DEFAULT_BASE_DIR = 'uploads';

/**
 * Sanitize a key by stripping path separators and traversal segments.
 *
 * @param {string} key
 * @returns {string}
 */
function sanitizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('storage key must be a non-empty string');
  }
  // Reject absolute paths and NUL bytes outright.
  if (path.isAbsolute(key) || key.includes('\0')) {
    throw new Error(`storage key "${key}" is not allowed`);
  }
  // Reject any `..` segments, anywhere in the key.
  const segments = key.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error(`storage key "${key}" is not allowed`);
  }
  return key;
}

/**
 * Resolve an absolute filesystem path for a key.
 *
 * @param {string} baseDir
 * @param {string} key
 * @returns {string}
 */
function resolvePath(baseDir, key) {
  return path.resolve(baseDir, sanitizeKey(key));
}

/**
 * Create the local filesystem storage driver.
 *
 * @param {Object} [config] - { baseDir, createDirs }.
 * @returns {Object} StorageDriver.
 */
export function createLocalStorage(config = {}) {
  const baseDir = typeof config.baseDir === 'string' && config.baseDir.length > 0
    ? path.resolve(config.baseDir)
    : path.resolve(DEFAULT_BASE_DIR);
  const createDirs = config.createDirs !== false;

  /**
   * Ensure the directory containing the resolved path exists.
   *
   * @param {string} fullPath
   */
  async function ensureDir(fullPath) {
    if (!createDirs) return;
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
  }

  return Object.freeze({
    provider: 'local',
    config: Object.freeze({ baseDir, createDirs }),

    async put(key, data, options = {}) {
      if (data === undefined || data === null) {
        throw new Error('storage.put requires data');
      }
      const fullPath = resolvePath(baseDir, key);
      await ensureDir(fullPath);
      const payload = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, options.encoding || 'utf8')
          : Buffer.from(JSON.stringify(data));
      await fs.writeFile(fullPath, payload);
      return { key, size: payload.length };
    },

    async get(key) {
      const fullPath = resolvePath(baseDir, key);
      return fs.readFile(fullPath);
    },

    async delete(key) {
      const fullPath = resolvePath(baseDir, key);
      try {
        await fs.unlink(fullPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    },

    async exists(key) {
      try {
        const fullPath = resolvePath(baseDir, key);
        await fs.access(fullPath);
        return true;
      } catch {
        return false;
      }
    },

    async list(prefix = '', options = {}) {
      const safePrefix = sanitizeKey(prefix);
      const startPath = safePrefix ? path.resolve(baseDir, safePrefix) : baseDir;
      const out = [];
      const limit = Number.isInteger(options.limit) ? options.limit : 1000;
      async function walk(dir) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          if (err?.code === 'ENOENT') return;
          throw err;
        }
        for (const entry of entries) {
          if (out.length >= limit) return;
          const entryPath = path.join(dir, entry.name);
          const rel = path.relative(baseDir, entryPath).split(path.sep).join('/');
          if (entry.isDirectory()) {
            await walk(entryPath);
          } else if (entry.isFile()) {
            out.push(rel);
          }
        }
      }
      await walk(startPath);
      return out;
    },

    async createWriteStream(key) {
      const fullPath = resolvePath(baseDir, key);
      await ensureDir(fullPath);
      const stream = createWriteStream(fullPath);
      // The returned stream is a node Writable. Wrap as a Promise that
      // resolves once the stream is opened.
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });
      return stream;
    },

    async presignedUrl(key, options = {}) {
      // Local driver does not produce signed URLs - return a stable
      // pseudo-URL useful for logs and tests. Production deployments use S3.
      const ttlSec = Number.isInteger(options.ttlSec) ? options.ttlSec : 300;
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
      return `local://${baseDir}/${sanitizeKey(key)}?expires=${expiresAt}`;
    },

    async close() {
      // Nothing to release on local driver.
    },
  });
}

// Avoid unused-warning on the explicit `Writable` import when this file is
// read by tooling that strips type-only imports.
void Writable;

export default createLocalStorage;
