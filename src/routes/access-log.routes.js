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
 *   - GET    /login-attempts      - every sign-in attempt (who, from where,
 *                                   outcome, reason; roadmap 2.5, gov.08)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('access_logs', <view|export>) -> adminScope.filtered()
 *   -> validate -> handler (tenant-scoped admins are clamped to their tenant)
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
import { adminScope } from '../middleware/adminScope.middleware.js';
import accessLogValidator from '../validators/accessLog.validator.js';
import accessLogController from '../controllers/accessLog.controller.js';

const router = Router();

router.get('/', adminAuth, permission('access_logs', 'view'), adminScope.filtered(), validate(accessLogValidator.listSchema), accessLogController.listAccessLogs);
router.get('/top-paths', adminAuth, permission('access_logs', 'view'), adminScope.filtered(), validate(accessLogValidator.topPathsSchema), accessLogController.getTopPaths);
router.get('/top-errors', adminAuth, permission('access_logs', 'view'), adminScope.filtered(), validate(accessLogValidator.topErrorsSchema), accessLogController.getTopErrors);
router.post('/export', adminAuth, permission('access_logs', 'export'), adminScope.filtered(), validate(accessLogValidator.exportSchema), accessLogController.requestExport);
router.get('/export/:exportId', adminAuth, permission('access_logs', 'view'), adminScope.filtered(), validate(accessLogValidator.exportStatusSchema), accessLogController.getExportStatus);
// audit (roadmap 2.5, gov.08): the per-attempt sign-in trail.
router.get('/login-attempts', adminAuth, permission('access_logs', 'view'), adminScope.filtered(), validate(accessLogValidator.loginAttemptsSchema), accessLogController.listLoginAttempts);

export default router;
