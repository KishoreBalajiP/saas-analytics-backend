/**
 * /api/v1/workspace/settings routes (tenant self-service).
 *
 * WHY IT EXISTS
 *   Workspace members manage their own workspace time zone, which decides
 *   how analytics date presets and report/alert schedules are read. The
 *   platform-admin settings surface stays at /tenants/:id/settings.
 *
 * ENDPOINTS
 *   - GET   /   effective workspace settings   permission settings.view
 *   - PATCH /   update { timezone }            permission settings.update
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('settings', <action>) -> validate -> handler
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import workspaceSettingsValidator from '../validators/workspaceSettings.validator.js';
import workspaceSettingsController from '../controllers/workspaceSettings.controller.js';

const router = Router();

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('settings', 'view'),
  workspaceSettingsController.getSettings,
);
router.patch(
  '/',
  authenticate,
  resolveTenant,
  permission('settings', 'update'),
  validate(workspaceSettingsValidator.workspaceSettingsUpdateSchema),
  workspaceSettingsController.updateSettings,
);

export default router;
