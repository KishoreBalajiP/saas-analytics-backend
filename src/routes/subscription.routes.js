/**
 * /api/v1/tenants/:id subscription routes (Phase 6 - implemented).
 *
 * PURPOSE
 *   The workspace-facing subscription surface. Mounted at
 *   `/tenants/:id` (NOT under the platform-admin `/tenants` router,
 *   which is adminAuth). Cross-tenant access is rejected by
 *   `tenantIsolation` matching the `:id` URL parameter to the
 *   authenticated user's tenant.
 *
 * ENDPOINTS (mounted under /tenants/:id)
 *   - GET    /subscription
 *   - GET    /subscription/timeline
 *   - POST   /subscription/cancel
 *   - POST   /subscription/change-plan
 *   - POST   /subscription/reactivate
 *   - GET    /entitlements
 *   - GET    /usage
 *
 * SECURITY
 *   - All endpoints require the workspace `authenticate` middleware
 *     AND `tenantIsolation` (so a user from tenant A cannot read
 *     tenant B's subscription by passing B's id in the URL).
 *   - Plan changes require `iam.subscriptions.update` (granted to
 *     Owner in `tenantInitialization.service.js`).
 *   - Read endpoints require `iam.subscriptions.view` or
 *     `iam.entitlements.view` (granted to Owner and Manager).
 *   - The `POST .../checkout` endpoint is intentionally NOT here:
 *     the workspace never calls the payment provider directly. The
 *     admin change-plan / set-state endpoints are the workspace-safe
 *     mutation surface; checkout lives under `/admin/subscriptions`
 *     and is platform-only.
 *   - The `ci:routes-exempt` annotation sits on the `router.<verb>(`
 *     line itself so the `check-routes` CI guard sees it inside the
 *     captured args; the file-level `authenticate` + `tenantIsolation`
 *     are the auth gates.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { tenantIsolation } from '../middleware/tenantIsolation.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import subscriptionValidator from '../validators/subscription.validator.js';
import entitlementValidator from '../validators/entitlement.validator.js';
import subscriptionController from '../controllers/subscription.controller.js';
import entitlementController from '../controllers/entitlement.controller.js';

const router = Router({ mergeParams: true });

const idParamSchema = {
  params: { id: { type: 'objectId', required: true } },
};

router.use(authenticate);
router.use(tenantIsolation({ readTenantId: (req) => req.params?.id ?? null }));

router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription',
  permission('iam.subscriptions', 'view'),
  validate(idParamSchema),
  subscriptionController.getSubscription,
);

router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/timeline',
  permission('iam.subscriptions', 'view'),
  validate(idParamSchema),
  subscriptionController.getTimeline,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/cancel',
  permission('iam.subscriptions', 'update'),
  validate({ ...idParamSchema, ...subscriptionValidator.cancelSchema }),
  subscriptionController.cancelSubscription,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/change-plan',
  permission('iam.subscriptions', 'update'),
  validate({ ...idParamSchema, ...subscriptionValidator.changePlanSchema }),
  subscriptionController.changePlan,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/reactivate',
  permission('iam.subscriptions', 'update'),
  validate(idParamSchema),
  subscriptionController.reactivate,
);

router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/entitlements',
  permission('iam.entitlements', 'view'),
  validate(idParamSchema),
  entitlementController.getEntitlements,
);

router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/usage',
  permission('iam.entitlements', 'view'),
  validate({ ...idParamSchema, ...entitlementValidator.getUsageSchema }),
  entitlementController.getUsage,
);

export default router;
