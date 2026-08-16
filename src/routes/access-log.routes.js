/**
 * /api/v1/access-logs routes - Per-request HTTP trace (Sprint 8 - implemented).
 *
 * WHY IT EXISTS
 *   Higher cardinality than audit logs: every authenticated HTTP request.
 *   Used for behaviour analytics, debugging, abuse detection. Writes come
 *   from `accessLog.middleware.js`. Backed by `governance/access-logs/`.
 *
 * ENDPOINTS
 *   - GET    /                    - filter + paginate
 *   - GET    /top-paths           - aggregated top paths
 *   - GET    /top-errors          - aggregated error rates
 *   - POST   /export              - request an async export (JSON/CSV)
 *   - GET    /export/:exportId    - poll status + download URL
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('access_logs', <view|export>) -> validate -> handler
 *
 * HOW TO EXTEND
 *   - Admin-only. Tenant-scoped admins see only their tenant (the
 *     controller derives the boundary from `req.admin.tenantId`).
 *   - Aggregation endpoints use the same time-range filters; results are
 *     capped at 100 rows server-side.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import accessLogValidator from '../validators/accessLog.validator.js';
import accessLogController from '../controllers/accessLog.controller.js';

const router = Router();

router.get('/', adminAuth, permission('access_logs', 'view'), validate(accessLogValidator.listSchema), accessLogController.listAccessLogs);
router.get('/top-paths', adminAuth, permission('access_logs', 'view'), validate(accessLogValidator.topPathsSchema), accessLogController.getTopPaths);
router.get('/top-errors', adminAuth, permission('access_logs', 'view'), validate(accessLogValidator.topErrorsSchema), accessLogController.getTopErrors);
router.post('/export', adminAuth, permission('access_logs', 'export'), validate(accessLogValidator.exportSchema), accessLogController.requestExport);
router.get('/export/:exportId', adminAuth, permission('access_logs', 'view'), validate(accessLogValidator.exportStatusSchema), accessLogController.getExportStatus);

export default router;
