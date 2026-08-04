/**
 * Audit Log Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/audit-logs`. Writes come from
 *   `middleware/audit.middleware.js`; reads come through here.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listAuditLogs, getAuditLog, requestExport, getExportStatus,
 *     listByModule
 *
 * CODING GUIDELINES
 *   - Admin-only access via `modulePermission('audit_logs', 'view')`.
 *   - Export requests are queued; returns an export id and polls status.
 *   - Pagination always returns `{ items, page, pageSize, total }`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listAuditLogs = notImplemented('GET /audit-logs');
export const getAuditLog = notImplemented('GET /audit-logs/:id');
export const requestExport = notImplemented('POST /audit-logs/export');
export const getExportStatus = notImplemented('GET /audit-logs/export/:exportId');
export const listByModule = notImplemented('GET /audit-logs/modules/:module');

export default {
  listAuditLogs, getAuditLog, requestExport, getExportStatus, listByModule,
};
