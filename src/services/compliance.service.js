/**
 * Compliance Service (architecture placeholder).
 *
 * PURPOSE
 *   Orchestrates data-subject requests (export, delete, restrict,
 *   consent). Records every state transition to `governance/audit-logs/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - fileRequest({ subjectId, type, reason, tenantScope? })
 *   - listRequests, getRequestStatus, cancelRequest
 *   - processExport, processDelete, processRestrict (queued jobs)
 *
 * CODING GUIDELINES
 *   - Even `no data found` outcomes produce a compliance log entry.
 *   - Tenant isolation is suspended for cross-tenant compliance flows.
 *   - Exports are queued to `src/queues/` and persisted to `src/storage/`.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const fileRequest = notImplementedStub('compliance.service', 'fileRequest');
export const listRequests = notImplementedStub('compliance.service', 'listRequests');
export const getRequestStatus = notImplementedStub('compliance.service', 'getRequestStatus');
export const cancelRequest = notImplementedStub('compliance.service', 'cancelRequest');
export const processExport = notImplementedStub('compliance.service', 'processExport');
export const processDelete = notImplementedStub('compliance.service', 'processDelete');
export const processRestrict = notImplementedStub('compliance.service', 'processRestrict');

export default {
  fileRequest, listRequests, getRequestStatus, cancelRequest,
  processExport, processDelete, processRestrict,
  _meta: { auditOnNoop: true },
};
