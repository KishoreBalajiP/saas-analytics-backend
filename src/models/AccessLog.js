/**
 * AccessLog (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Per-request HTTP trace. Higher cardinality than AuditLog. Captured
 *   by `accessLog.middleware.js`.
 *
 * PLANNED FIELDS
 *   _id, occurredAt,
 *   actorId?, actorType?,
 *   tenantId? | null,
 *   method, path, statusCode,
 *   latencyMs, requestSize, responseSize,
 *   ip, userAgent,
 *   requestId,                               // ties to AuditLog
 *   apiKeyId?,
 *   error?: { code, message }
 *
 * PLANNED INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { actorId: 1, occurredAt: -1 }
 *   - { path: 1, occurredAt: -1 }            // aggregate top paths
 *   - { statusCode: 1, occurredAt: -1 }
 *
 * STORAGE
 *   - Mongo (with time-series collection in Phase 3+).
 *   - Cold tier (S3) for entries > 7 days old.
 */

export const MODEL_NAME = 'AccessLog';

export default Object.freeze({
  name: MODEL_NAME,
  highCardinality: true,
  retentionDriven: true,
  schemaImplemented: false,
  seeAlso: [
    'src/middleware/accessLog.middleware.js',
    'src/services/accessLog.service.js',
    'src/repositories/accessLog.repository.js',
  ],
});
