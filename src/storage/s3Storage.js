/**
 * S3 (S3-compatible) storage provider placeholder.
 *
 * WHY IT EXISTS
 *   Production deployments (Render, Railway, AWS ECS) store uploads/exports
 *   in object storage - AWS S3 or S3-compatible services (MinIO, DigitalOcean
 *   Spaces, Cloudflare R2). This provider abstracts that so business logic
 *   never talks to the AWS SDK directly.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `StorageDriver` surface as every
 *   other provider. PLACEHOLDER - all methods fail closed until implemented.
 *
 * DRIVER SURFACE (identical to localStorage.js - see its JSDoc):
 *   put, get, delete, exists, list, createWriteStream, presignedUrl
 *
 * CONFIG (future):
 *   { provider: 's3', bucket, region, accessKeyId, secretAccessKey, endpoint?, forcePathStyle? }
 *   Credentials come from env/config - never from code or logs.
 *
 * HOW TO EXTEND
 *   Implement with `@aws-sdk/client-s3` (the only future dependency), keep
 *   the driver surface identical, and use `presignedUrl` for browser uploads
 *   instead of proxying bytes through the API.
 */

import { createStubDriver } from '../utils/stubs.js';

const DRIVER_METHODS = ['put', 'get', 'delete', 'exists', 'list', 'createWriteStream', 'presignedUrl'];

/**
 * Create the S3 storage driver.
 * PLACEHOLDER - returns a fail-closed stub in Phase 1.1.
 *
 * @param {Object} [config] - { bucket, region, endpoint, ... }.
 * @returns {Object} StorageDriver (stub).
 */
export function createS3Storage(config = {}) {
  return Object.freeze({
    provider: 's3',
    config: Object.freeze({
      bucket: config.bucket ?? null,
      region: config.region ?? 'us-east-1',
      endpoint: config.endpoint ?? null,
      forcePathStyle: config.forcePathStyle ?? false,
    }),
    ...createStubDriver('s3Storage', DRIVER_METHODS),
  });
}
