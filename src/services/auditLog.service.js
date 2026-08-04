/**
 * Audit Log Service (architecture placeholder).
 *
 * PURPOSE
 *   Single write entry point for audit events. Reads + exports are also
 *   implemented here. Writes MUST go through this service so the data
 *   shape stays consistent across modules.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - emit({ actor, action, module, resource, before, after, reason })
 *   - list(filters), getById, listByModule
 *   - requestExport(filters) -> exportId, getExportStatus(exportId)
 *
 * CODING GUIDELINES
 *   - Sensitive payloads (passwords, tokens, refreshTokenHash) MUST be
 *     redacted by the service before persistence.
 *   - Export jobs go through `src/queues/` -> `src/storage/`.
 *   - All reads filter by tenant unless the actor is a platform admin.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const emit = notImplementedStub('auditLog.service', 'emit');
export const list = notImplementedStub('auditLog.service', 'list');
export const getById = notImplementedStub('auditLog.service', 'getById');
export const listByModule = notImplementedStub('auditLog.service', 'listByModule');
export const requestExport = notImplementedStub('auditLog.service', 'requestExport');
export const getExportStatus = notImplementedStub('auditLog.service', 'getExportStatus');

export default {
  emit, list, getById, listByModule, requestExport, getExportStatus,
  _meta: { hotPath: false, queue: 'analytics.jobs (planned)' },
};
