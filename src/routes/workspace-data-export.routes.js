/**
 * /api/v1/workspace/data-exports routes (roadmap 2.9 - tenant data export).
 *
 * WHY IT EXISTS
 *   A workspace Owner exports everything the workspace owns as a portable
 *   archive (JSON lines per collection, CSV per dataset, manifest with
 *   counts and checksums). The export runs as a job; the archive expires.
 *
 * ENDPOINTS
 *   - GET  /                          list exports          data_exports.view
 *   - POST /                          request an export     data_exports.export
 *   - GET  /:exportId                 export status         data_exports.view
 *   - POST /:exportId/download-url    short-lived link      data_exports.export
 *   - DELETE /:exportId               delete the archive    data_exports.export
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('data_exports', <action>) -> validate -> handler
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import tenantExportValidator from '../validators/tenantExport.validator.js';
import tenantExportController from '../controllers/tenantExport.controller.js';

const router = Router();

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('data_exports', 'view'),
  validate(tenantExportValidator.workspaceListSchema),
  tenantExportController.listWorkspaceExports,
);
router.post(
  '/',
  authenticate,
  resolveTenant,
  permission('data_exports', 'export'),
  tenantExportController.requestWorkspaceExport,
);
router.get(
  '/:exportId',
  authenticate,
  resolveTenant,
  permission('data_exports', 'view'),
  validate(tenantExportValidator.workspaceExportParamsSchema),
  tenantExportController.getWorkspaceExport,
);
router.post(
  '/:exportId/download-url',
  authenticate,
  resolveTenant,
  permission('data_exports', 'export'),
  validate(tenantExportValidator.workspaceExportParamsSchema),
  tenantExportController.issueWorkspaceDownloadUrl,
);
router.delete(
  '/:exportId',
  authenticate,
  resolveTenant,
  permission('data_exports', 'export'),
  validate(tenantExportValidator.workspaceExportParamsSchema),
  tenantExportController.revokeWorkspaceExport,
);

export default router;
