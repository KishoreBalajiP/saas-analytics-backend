/**
 * /api/v1/admin/security-alerts routes - platform security alerts
 * (roadmap 2.6, document 11 section 4).
 *
 * WHY IT EXISTS
 *   Triage surface for the alerts raised by the security detector job:
 *   list / filter, read evidence, acknowledge, mark false positive, resolve
 *   with a note, and inspect the rule catalogue with its thresholds.
 *
 * ENDPOINTS
 *   - GET  /                       list (filters: status, severity, ruleId,
 *                                  tenantId, search, from, to; paginated)
 *   - GET  /rules                  rule catalogue, effective thresholds,
 *                                  watermarks
 *   - GET  /:id                    one alert with evidence and history
 *   - POST /:id/acknowledge        open -> acknowledged (takes ownership)
 *   - POST /:id/false-positive     open|acknowledged -> false_positive (note)
 *   - POST /:id/resolve            open|acknowledged -> resolved (note)
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('security.alerts', 'view' | 'update')
 *   -> validate(schema) -> handler
 *   Tenant-scoped administrators only see their tenant's alerts (service).
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import securityAlertController from '../controllers/securityAlert.controller.js';
import securityAlertValidator from '../validators/securityAlert.validator.js';

const MODULE = 'security.alerts';

const router = Router();

router.get(
  '/',
  adminAuth,
  permission(MODULE, 'view'),
  validate(securityAlertValidator.listSchema),
  securityAlertController.listAlerts,
);
router.get(
  '/rules',
  adminAuth,
  permission(MODULE, 'view'),
  securityAlertController.listRules,
);
router.get(
  '/:id',
  adminAuth,
  permission(MODULE, 'view'),
  validate(securityAlertValidator.getSchema),
  securityAlertController.getAlert,
);
router.post(
  '/:id/acknowledge',
  adminAuth,
  permission(MODULE, 'update'),
  validate(securityAlertValidator.acknowledgeSchema),
  securityAlertController.acknowledgeAlert,
);
router.post(
  '/:id/false-positive',
  adminAuth,
  permission(MODULE, 'update'),
  validate(securityAlertValidator.closeSchema),
  securityAlertController.markFalsePositive,
);
router.post(
  '/:id/resolve',
  adminAuth,
  permission(MODULE, 'update'),
  validate(securityAlertValidator.closeSchema),
  securityAlertController.resolveAlert,
);

export default router;
