/**
 * /api/v1/feature-flags routes - feature flag registry + evaluation
 * (roadmap 2.4 - implemented).
 *
 * WHY IT EXISTS
 *   Decouple deployment from release. Platform admins roll features out to
 *   everyone, to an allow-list of tenants, or to a stable percentage of
 *   tenants; workspaces read the result for themselves.
 *
 * ENDPOINTS
 *   Tenant users (authenticate -> resolveTenant -> permission):
 *   - GET    /evaluate              this workspace's flags     feature_flags.view
 *
 *   Platform admins (adminAuth -> requirePlatformScope -> permission):
 *   - GET    /                      list                       feature_flags.view
 *   - POST   /                      create                     feature_flags.create
 *   - GET    /preview?tenantId=     outcomes for one tenant    feature_flags.view
 *   - GET    /:key                  detail                     feature_flags.view
 *   - PATCH  /:key                  update / rollout           feature_flags.update
 *   - DELETE /:key?version=         delete (non-system flags)  feature_flags.delete
 *   - GET    /:key/history          versions, newest first     feature_flags.view
 *   - POST   /:key/rollback         restore { toVersion }      feature_flags.update
 *
 * RULES
 *   - Every change is versioned (409 VERSION_CONFLICT on a stale
 *     `version`), recorded in the history, audited, and invalidates the
 *     evaluation cache immediately.
 *   - Flag keys contain a dot, so `/evaluate` and `/preview` can never
 *     collide with a flag key.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { requirePlatformScope } from '../middleware/configAccess.middleware.js';
import { validate } from '../validators/index.js';
import featureFlagValidator from '../validators/featureFlag.validator.js';
import featureFlagController from '../controllers/featureFlag.controller.js';

const router = Router();

/* ---------------------------- tenant users ---------------------------- */

router.get(
  '/evaluate',
  authenticate,
  resolveTenant,
  permission('feature_flags', 'view'),
  featureFlagController.evaluateFlags,
);

/* --------------------------- platform admins -------------------------- */

router.get(
  '/',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'view'),
  validate(featureFlagValidator.listSchema),
  featureFlagController.listFlags,
);
router.post(
  '/',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'create'),
  validate(featureFlagValidator.createSchema),
  featureFlagController.createFlag,
);
router.get(
  '/preview',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'view'),
  validate(featureFlagValidator.previewSchema),
  featureFlagController.previewFlags,
);
router.get(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'view'),
  validate(featureFlagValidator.keyParamSchema),
  featureFlagController.getFlag,
);
router.patch(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'update'),
  validate(featureFlagValidator.updateSchema),
  featureFlagController.updateFlag,
);
router.delete(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'delete'),
  validate(featureFlagValidator.deleteSchema),
  featureFlagController.deleteFlag,
);
router.get(
  '/:key/history',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'view'),
  validate(featureFlagValidator.historySchema),
  featureFlagController.flagHistory,
);
router.post(
  '/:key/rollback',
  adminAuth,
  requirePlatformScope,
  permission('feature_flags', 'update'),
  validate(featureFlagValidator.rollbackSchema),
  featureFlagController.rollbackFlag,
);

export default router;
