/**
 * Audit Log Controller (Sprint 2 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/audit-logs`. Writes come from
 *   `middleware/audit.middleware.js`; reads come through here.
 *
 * RESPONSIBILITY
 *   - listAuditLogs, getAuditLog, requestExport, getExportStatus,
 *     listByModule
 *
 * CODING GUIDELINES
 *   - Admin-only access via `adminAuth` + permission middleware on the
 *     route layer.
 *   - Export requests reserve an id and a `queued` state; the materialising
 *     queue consumer is a later-sprint deliverable.
 *   - Pagination always returns `{ docs, page, limit, total, pages }`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import auditLogService from '../services/auditLog.service.js';

/** GET /audit-logs - filter + paginate the trail. */
export const listAuditLogs = asyncHandler(async (req, res) => {
  const {
    tenantId, module, action, actorId, actorType, result, page, limit,
  } = req.validated?.query ?? {};
  const data = await auditLogService.list({
    tenantId,
    module,
    action,
    actorId,
    actorType,
    result,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, data.docs, 'Audit entries fetched', {
    page: data.page,
    limit: data.limit,
    total: data.total,
    pages: data.pages,
  });
});

/** GET /audit-logs/:id - fetch a single entry. */
export const getAuditLog = asyncHandler(async (req, res) => {
  const entry = await auditLogService.getById({ id: req.params.id });
  return ApiResponse.ok(res, entry, 'Audit entry fetched');
});

/** POST /audit-logs/export - request an export (queued). */
export const requestExport = asyncHandler(async (req, res) => {
  const filters = req.validated?.body?.filters ?? {};
  const exportJob = await auditLogService.requestExport({
    filters,
    requestedBy: req.admin?.id ?? null,
  });
  return ApiResponse.accepted(res, exportJob, 'Audit export requested');
});

/** GET /audit-logs/export/:exportId - poll export status. */
export const getExportStatus = asyncHandler(async (req, res) => {
  const status = await auditLogService.getExportStatus({ exportId: req.params.exportId });
  return ApiResponse.ok(res, status, 'Export status');
});

/** GET /audit-logs/modules/:module - entries for one module. */
export const listByModule = asyncHandler(async (req, res) => {
  const { page, limit, tenantId } = req.validated?.query ?? {};
  const data = await auditLogService.listByModule({
    module: req.params.module,
    tenantId,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, data.docs, 'Audit entries fetched', {
    page: data.page,
    limit: data.limit,
    total: data.total,
    pages: data.pages,
  });
});

export default {
  listAuditLogs, getAuditLog, requestExport, getExportStatus, listByModule,
};
