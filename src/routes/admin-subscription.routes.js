/**
 * /api/v1/admin/subscriptions routes (Phase 6 - implemented).
 *
 * PURPOSE
 *   Platform-admin subscription surface. Mounted under
 *   `/admin/subscriptions`. Mutations require the
 *   `billing.subscriptions.override` permission; reads require
 *   `billing.subscriptions.view`.
 *
 * ENDPOINTS
 *   - GET  /                            paginated list (view)
 *   - GET  /:tenantId                   single subscription (view)
 *   - GET  /:tenantId/timeline          history (view)
 *   - POST /:tenantId/change-plan       change plan (override)
 *   - POST /:tenantId/set-state         administrative state change (override)
 *   - POST /:tenantId/checkout          provider adapter (501 when disabled)
 *   - GET  /:tenantId/transactions      payment transactions (view)
 *   - GET  /:tenantId/webhooks          correlated webhook events (view)
 *   - POST /reconcile                   operator-triggered reconcile (override)
 *
 * SECURITY
 *   - All routes require `adminAuth` AND a `billing.subscriptions.*` key.
 *   - The state-change endpoint requires a non-empty `reason` and audits
 *     the actor / target / previous / new / reason / timestamp.
 *   - The checkout endpoint is honest about the not-implemented state.
 *   - The `ci:routes-exempt` annotation sits on the `router.<verb>(`
 *     line itself so the `check-routes` CI guard sees it inside the
 *     captured args; the file-level `adminAuth` is the auth gate.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import subscriptionValidator from '../validators/subscription.validator.js';
import adminSubscriptionController from '../controllers/adminSubscription.controller.js';

const router = Router();
router.use(adminAuth);

router.get( // ci:routes-exempt: adminAuth above
  '/',
  permission('billing.subscriptions', 'view'),
  validate(subscriptionValidator.adminListSchema),
  adminSubscriptionController.listSubscriptions,
);

router.get( // ci:routes-exempt: adminAuth above
  '/:tenantId',
  permission('billing.subscriptions', 'view'),
  validate(subscriptionValidator.tenantIdParamSchema),
  adminSubscriptionController.getSubscriptionForTenant,
);

router.get( // ci:routes-exempt: adminAuth above
  '/:tenantId/timeline',
  permission('billing.subscriptions', 'view'),
  validate(subscriptionValidator.tenantIdParamSchema),
  adminSubscriptionController.getTenantTimeline,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:tenantId/change-plan',
  permission('billing.subscriptions', 'override'),
  validate(subscriptionValidator.adminChangePlanSchema),
  adminSubscriptionController.adminChangePlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:tenantId/set-state',
  permission('billing.subscriptions', 'override'),
  validate(subscriptionValidator.adminSetStateSchema),
  adminSubscriptionController.adminSetState,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:tenantId/checkout',
  permission('billing.subscriptions', 'override'),
  adminSubscriptionController.createCheckoutSession,
);

router.get( // ci:routes-exempt: adminAuth above
  '/:tenantId/transactions',
  permission('billing.subscriptions', 'view'),
  validate(subscriptionValidator.tenantIdParamSchema),
  adminSubscriptionController.listTransactions,
);

router.get( // ci:routes-exempt: adminAuth above
  '/:tenantId/webhooks',
  permission('billing.subscriptions', 'view'),
  validate(subscriptionValidator.tenantIdParamSchema),
  adminSubscriptionController.listWebhooks,
);

router.post( // ci:routes-exempt: adminAuth above
  '/reconcile',
  permission('billing.subscriptions', 'override'),
  validate(subscriptionValidator.reconcileSchema),
  adminSubscriptionController.triggerReconcile,
);

export default router;
