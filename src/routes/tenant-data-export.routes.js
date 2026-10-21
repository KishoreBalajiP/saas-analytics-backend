/**
 * /api/v1/tenants/:id/data-exports routes (roadmap 2.9 - platform side).
 *
 * WHY IT EXISTS
 *   Platform admins export a tenant's data for support (for example a
 *   portability request from a suspended or closed workspace). A support
 *   reason is mandatory and every step is audited. Admins scoped to one
 *   tenant (`tenantScope`) can only export that tenant.
 *
 * ENDPOINTS (mounted under /tenants/:id/data-exports)
 *   - GET  /                          list exports        iam.tenants.view
 *   - POST /                          request an export   iam.tenants.export
 *   - GET  /:exportId                 export status       iam.tenants.view
 *   - POST /:exportId/download-url    short-lived link    iam.tenants.export
 *   - DELETE /:exportId               delete the archive  iam.tenants.export
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.tenants', <action>) -> validate -> handler
 *
 * NOTE
 *   Mounted BEFORE `/tenants/:id` (workspace subscription router), whose
 *   router-level `authenticate` would otherwise reject admin tokens.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import { validate } from '../validators/index.js';
import tenantExportValidator from '../validators/tenantExport.validator.js';
import tenantExportController from '../controllers/tenantExport.controller.js';

const router = Router({ mergeParams: true });

router.get('/', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), validate(tenantExportValidator.platformListSchema), tenantExportController.listTenantExports);
router.post('/', adminAuth, permission('iam.tenants', 'export'), adminScope.tenant(), validate(tenantExportValidator.platformRequestSchema), tenantExportController.requestTenantExport);
router.get('/:exportId', adminAuth, permission('iam.tenants', 'view'), adminScope.tenant(), validate(tenantExportValidator.platformExportParamsSchema), tenantExportController.getTenantExport);
router.post('/:exportId/download-url', adminAuth, permission('iam.tenants', 'export'), adminScope.tenant(), validate(tenantExportValidator.platformExportParamsSchema), tenantExportController.issueTenantDownloadUrl);
router.delete('/:exportId', adminAuth, permission('iam.tenants', 'export'), adminScope.tenant(), validate(tenantExportValidator.platformExportParamsSchema), tenantExportController.revokeTenantExport);

export default router;
