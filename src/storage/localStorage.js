/**
 * Local (filesystem) storage provider placeholder.
 *
 * WHY IT EXISTS
 *   Default storage for development/tests and small deployments: files live
 *   under a configurable base directory (e.g. the `uploads/` folder).
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `StorageDriver` surface as every
 *   other provider. PLACEHOLDER - all methods fail closed until implemented.
 *
 * DRIVER SURFACE (documented, shared by all providers):
 *   - put(key, data, options)          -> Promise<{ key }>
 *   - get(key)                         -> Promise<Buffer>
 *   - delete(key)                      -> Promise<void>
 *   - exists(key)                      -> Promise<boolean>
 *   - list(prefix, options)            -> Promise<string[]>
 *   - createWriteStream(key)           -> Promise<NodeJS.WritableStream>
 *   - presignedUrl(key, options)       -> Promise<string>
 *
 * CONFIG (future):
 *   { provider: 'local', baseDir: 'uploads', createDirs: true }
 *
 * HOW TO EXTEND
 *   Implement the methods with `fs/promises` (or a streaming helper), keep
 *   the surface identical, and always sanitize keys (no path traversal).
 */

import { createStubDriver } from '../utils/stubs.js';

const DRIVER_METHODS = ['put', 'get', 'delete', 'exists', 'list', 'createWriteStream', 'presignedUrl'];

/**
 * Create the local filesystem storage driver.
 * PLACEHOLDER - returns a fail-closed stub in Phase 1.1.
 *
 * @param {Object} [config] - { baseDir, createDirs }.
 * @returns {Object} StorageDriver (stub).
 */
export function createLocalStorage(config = {}) {
  return Object.freeze({
    provider: 'local',
    config: Object.freeze({ baseDir: config.baseDir ?? 'uploads', createDirs: config.createDirs ?? true }),
    ...createStubDriver('localStorage', DRIVER_METHODS),
  });
}
