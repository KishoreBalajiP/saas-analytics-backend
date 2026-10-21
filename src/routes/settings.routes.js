/**
 * /api/v1/settings routes - platform settings (roadmap 2.4 - implemented).
 *
 * WHY IT EXISTS
 *   Platform admins change the PLATFORM value of each catalogue setting
 *   (`DEFAULT_SETTINGS` in `services/tenantSettings.service.js`) without a
 *   redeploy. Tenants inherit the platform value unless they override it
 *   (tenant overrides: `/tenants/:id/settings`, `/workspace/settings`).
 *
 * ENDPOINTS
 *   - GET    /                 list (secrets masked)          settings.view
 *   - GET    /:key             one setting (secret masked)    settings.view
 *   - PUT    /:key             change { value, version? }     settings.update
 *                                (+ settings.secrets.update for a secret)
 *   - POST   /:key/reset       back to the built-in default   settings.update
 *   - GET    /:key/history     versions, newest first         settings.view
 *   - POST   /:key/rollback    restore { toVersion }          settings.update
 *   - GET    /:key/secret      decrypted secret (audited)     settings.secrets.view
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> requirePlatformScope -> permission(...) -> validate -> handler
 *
 * RULES
 *   - Every change is validated per key, versioned (optimistic concurrency
 *     on `version`, 409 VERSION_CONFLICT), recorded in the history and
 *     audited with secrets redacted.
 *   - Settings are a code-defined catalogue: there is no create/delete.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { requirePlatformScope } from '../middleware/configAccess.middleware.js';
import { validate } from '../validators/index.js';
import settingValidator from '../validators/setting.validator.js';
import settingController from '../controllers/setting.controller.js';

const router = Router();

router.get(
  '/',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'view'),
  validate(settingValidator.listSchema),
  settingController.listSettings,
);
router.get(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'view'),
  validate(settingValidator.keyParamSchema),
  settingController.getSetting,
);
router.put(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'update'),
  validate(settingValidator.updateSchema),
  settingController.updateSetting,
);
router.post(
  '/:key/reset',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'update'),
  validate(settingValidator.resetSchema),
  settingController.resetSetting,
);
router.get(
  '/:key/history',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'view'),
  validate(settingValidator.historySchema),
  settingController.settingHistory,
);
router.post(
  '/:key/rollback',
  adminAuth,
  requirePlatformScope,
  permission('settings', 'update'),
  validate(settingValidator.rollbackSchema),
  settingController.rollbackSetting,
);
router.get(
  '/:key/secret',
  adminAuth,
  requirePlatformScope,
  permission('settings.secrets', 'view'),
  validate(settingValidator.keyParamSchema),
  settingController.revealSecret,
);

export default router;
