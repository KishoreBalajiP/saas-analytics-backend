/**
 * AuditLog (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Append-only record of meaningful state changes. Captured by
 *   `audit.middleware.js` and emitted by services. Read via
 *   `routes/audit-log.routes.js`.
 *
 * PLANNED FIELDS
 *   _id, occurredAt,
 *   actorType: 'admin' | 'user' | 'service' | 'system',
 *   actorId, actorDisplay,
 *   tenantId | null,
 *   module, action,                           // e.g. 'iam.admins'/'suspend'
 *   resourceType, resourceId,
 *   before?, after?,                         // optional diff
 *   reason?, ip, userAgent,
 *   requestId,                               // ties to AccessLog
 *   result: 'success' | 'failure',
 *   errorCode?
 *
 * PLANNED INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { actorId: 1, occurredAt: -1 }
 *   - { module: 1, action: 1, occurredAt: -1 }
 *
 * STORAGE
 *   - Mongo (with time-series collection in Phase 3+).
 *   - Cold tier (S3) for entries > 30 days old.
 *
 * APPEND-ONLY
 *   - Update / delete ONLY via the retention purge path, and only when
 *     the retention window has elapsed.
 */

export const MODEL_NAME = 'AuditLog';
export const APPEND_ONLY = true;

export default Object.freeze({
  name: MODEL_NAME,
  appendOnly: APPEND_ONLY,
  retentionDriven: true,
  schemaImplemented: false,
  seeAlso: [
    'src/middleware/audit.middleware.js',
    'src/services/auditLog.service.js',
    'src/repositories/auditLog.repository.js',
  ],
});
