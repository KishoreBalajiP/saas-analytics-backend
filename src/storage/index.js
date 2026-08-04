/**
 * Storage abstraction facade (placeholder).
 *
 * WHY IT EXISTS
 *   Files (CSV uploads, exports, images) are stored differently per
 *   deployment: local disk in dev, S3/S3-compatible in production. This
 *   facade gives business logic one `StorageDriver` interface so switching
 *   providers never touches application code.
 *
 * RESPONSIBILITY
 *   - Define the canonical provider names.
 *   - Route `createStorage(config)` to the right provider factory.
 *   - Each provider returns a driver with the SAME method surface.
 *
 * HOW TO EXTEND
 *   Add a provider by creating `<name>Storage.js` exporting a factory that
 *   returns the documented driver surface, then map it here. Selection is
 *   config-driven (`provider`), never environment-detected in code.
 *
 *   ```js
 *   import { createStorage } from '../storage/index.js';
 *   const storage = createStorage({ provider: STORAGE_PROVIDERS.S3, bucket: '...' });
 *   await storage.put('connectors/csv/abc.csv', buffer);
 *   ```
 */

import { createLocalStorage } from './localStorage.js';
import { createS3Storage } from './s3Storage.js';

/** Canonical storage providers. */
export const STORAGE_PROVIDERS = Object.freeze({
  LOCAL: 'local',
  S3: 's3',
});

/**
 * Create a storage driver for the requested provider.
 * PLACEHOLDER in Phase 1.1 - providers return fail-closed stubs.
 *
 * @param {Object} [config] - { provider, baseDir?, bucket?, region?, ... }.
 * @returns {Object} StorageDriver (stub until implemented).
 */
export function createStorage(config = {}) {
  const provider = config.provider ?? STORAGE_PROVIDERS.LOCAL;
  switch (provider) {
    case STORAGE_PROVIDERS.LOCAL:
      return createLocalStorage(config);
    case STORAGE_PROVIDERS.S3:
      return createS3Storage(config);
    default:
      throw new Error(`Unknown storage provider "${provider}"`);
  }
}

export { createLocalStorage, createS3Storage };

export default {
  STORAGE_PROVIDERS,
  createStorage,
  createLocalStorage,
  createS3Storage,
};
