/**
 * /api/v1/audit-logs routes - Read-only audit trail (Sprint 2 - implemented).
 *
 * WHY IT EXISTS
 *   Compliance + customer support depend on a searchable audit trail.
 *   Writes happen via `audit.middleware.js` (or directly from services that
 *   emit domain events). Reads happen here. Backed by
 *   `services/auditLog.service.js`.
 *
 * ENDPOINTS
 *   - GET    /                   - filter + paginate
 *   - GET    /:id                - fetch one
 *   - POST   /export             - request an export (queued)
 *   - GET    /export/:exportId   - check status + presigned URL
 *   - GET    /modules/:module    - filter by module
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('audit_logs', <view|export>) -> handler
 *
 * HOW TO EXTEND
 *   - All endpoints are admin-gated on the `audit_logs` module (see
 *     `modules/iam/permissions/README.md` for the module catalogue).
 *   - Exports flow through `src/queues/` -> `src/storage/` so the HTTP
 *     request never blocks; the materialising consumer is a later sprint.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import auditLogController from '../controllers/auditLog.controller.js';

const router = Router();

router.get('/', adminAuth, permission('audit_logs', 'view'), auditLogController.listAuditLogs);
router.get('/modules/:module', adminAuth, permission('audit_logs', 'view'), auditLogController.listByModule);
router.post('/export', adminAuth, permission('audit_logs', 'export'), auditLogController.requestExport);
router.get('/export/:exportId', adminAuth, permission('audit_logs', 'view'), auditLogController.getExportStatus);
router.get('/:id', adminAuth, permission('audit_logs', 'view'), auditLogController.getAuditLog);

export default router;
