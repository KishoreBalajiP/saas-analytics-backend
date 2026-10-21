/**
 * /api/v1/audit-logs routes - Read-only audit trail (Sprint 2 - implemented,
 * Sprint 8 - async exports + safe filters).
 *
 * WHY IT EXISTS
 *   Compliance + customer support depend on a searchable audit trail.
 *   Writes happen through `auditLog.service#emit` (model rows, domain
 *   events, security events incl. denied requests). Reads happen here;
 *   `?category=security` lists security events. Backed by
 *   `services/auditLog.service.js` + `services/auditExport.service.js`.
 *
 * ENDPOINTS
 *   - GET    /                   - filter + paginate
 *   - GET    /:id                - fetch one
 *   - POST   /export             - request an async export (JSON or CSV)
 *   - GET    /export/:exportId   - poll status + download URL
 *   - GET    /modules/:module    - filter by module
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('audit_logs', <view|export>) -> adminScope.filtered()
 *   -> validate -> handler. Tenant-scoped admins only see their tenant's
 *   entries (list, module view, detail and exports are clamped).
 *
 * HOW TO EXTEND
 *   - All endpoints are admin-gated on the `audit_logs` module (see
 *     `modules/iam/permissions/README.md` for the module catalogue).
 *   - Exports flow through `src/queues/` -> `src/storage/`; the export
 *     consumer (`jobs/export.worker.js`) materialises the artifact.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import auditValidator from '../validators/audit.validator.js';
import auditLogController from '../controllers/auditLog.controller.js';

const router = Router();

router.get('/', adminAuth, permission('audit_logs', 'view'), adminScope.filtered(), validate(auditValidator.listSchema), auditLogController.listAuditLogs);
router.get('/modules/:module', adminAuth, permission('audit_logs', 'view'), adminScope.filtered(), validate(auditValidator.moduleSchema), auditLogController.listByModule);
router.post('/export', adminAuth, permission('audit_logs', 'export'), adminScope.filtered(), validate(auditValidator.exportSchema), auditLogController.requestExport);
router.get('/export/:exportId', adminAuth, permission('audit_logs', 'view'), adminScope.filtered(), validate(auditValidator.exportStatusSchema), auditLogController.getExportStatus);
router.get('/:id', adminAuth, permission('audit_logs', 'view'), adminScope.filtered(), auditLogController.getAuditLog);

export default router;
