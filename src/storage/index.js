/**
 * Storage abstraction facade.
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

import env from '../config/env.js';
import { createLocalStorage } from './localStorage.js';
import { createS3Storage } from './s3Storage.js';

/** Canonical storage providers. */
export const STORAGE_PROVIDERS = Object.freeze({
  LOCAL: 'local',
  S3: 's3',
});

/**
 * Determine the default storage provider from configuration.
 *
 * Returns `s3` when `STORAGE_PROVIDER=s3` is set AND `S3_BUCKET` is
 * configured. Defaults to `local`.
 *
 * @returns {string}
 */
function defaultProvider() {
  return env.storage?.provider ?? STORAGE_PROVIDERS.LOCAL;
}

/**
 * Create a storage driver for the requested provider.
 *
 * @param {Object} [config] - { provider, baseDir?, bucket?, region?, ... }.
 * @returns {Object} StorageDriver.
 */
export function createStorage(config = {}) {
  const provider = config.provider ?? defaultProvider();
  switch (provider) {
    case STORAGE_PROVIDERS.LOCAL:
      return createLocalStorage(config);
    case STORAGE_PROVIDERS.S3:
      return createS3Storage({
        ...env.storage,
        ...config,
      });
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
