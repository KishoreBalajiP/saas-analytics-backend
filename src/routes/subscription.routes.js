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
 *   - GET    /plans
 *   - GET    /subscription
 *   - GET    /subscription/timeline
 *   - POST   /subscription/cancel
 *   - POST   /subscription/change-plan
 *   - POST   /subscription/checkout        (Razorpay order, server-priced,
 *                                           one prepaid month/year term)
 *   - POST   /subscription/verify          (browser callback: signature
 *                                           check + status, never grants)
 *   - GET    /subscription/checkout/:orderId  (billing: confirmation status)
 *   - GET    /subscription/transactions    (billing: workspace history)
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
 *   - `POST .../checkout` creates a Razorpay Order with server-
 *     controlled pricing and returns only public fields (order id,
 *     key id, amount, currency). `POST .../verify` authoritatively
 *     verifies the payment before the lifecycle service activates
 *     anything. Browser callbacks alone never grant entitlements.
 *     Paid access is enforced at the entitlement resolver, not the UI.
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
  validate({
    ...idParamSchema,
    query: {
      page: { type: 'integer', min: 1, max: 1000 },
      limit: { type: 'integer', min: 1, max: 100 },
    },
  }),
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

router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/plans',
  permission('iam.subscriptions', 'view'),
  validate(idParamSchema),
  subscriptionController.listPurchasablePlans,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/checkout',
  permission('iam.subscriptions', 'update'),
  validate({
    ...idParamSchema,
    body: {
      planId: { type: 'string', required: true, maxLength: 60 },
      // billing: the prepaid term to buy.
      interval: { type: 'string', oneOf: ['month', 'year'] },
    },
  }),
  subscriptionController.createCheckoutSession,
);

// billing: the checkout UI polls this until the provider-confirmed capture
// has been applied (`phase: confirmed`).
router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/checkout/:orderId',
  permission('iam.subscriptions', 'view'),
  validate({
    params: {
      id: { type: 'objectId', required: true },
      orderId: { type: 'string', required: true, maxLength: 100, pattern: /^[A-Za-z0-9_-]+$/ },
    },
  }),
  subscriptionController.getCheckoutStatus,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/checkout/:orderId/cancel',
  permission('iam.subscriptions', 'update'),
  validate({
    params: {
      id: { type: 'objectId', required: true },
      orderId: { type: 'string', required: true, maxLength: 100, pattern: /^[A-Za-z0-9_-]+$/ },
    },
  }),
  subscriptionController.cancelCheckout,
);

// billing: workspace billing history (payment transactions, no secrets).
router.get( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/transactions',
  permission('iam.subscriptions', 'view'),
  validate({
    ...idParamSchema,
    query: {
      page: { type: 'integer', min: 1, max: 1000 },
      limit: { type: 'integer', min: 1, max: 100 },
    },
  }),
  subscriptionController.listTransactions,
);

router.post( // ci:routes-exempt: authenticate + tenantIsolation above
  '/subscription/verify',
  permission('iam.subscriptions', 'update'),
  validate({
    ...idParamSchema,
    body: {
      razorpay_order_id: { type: 'string', required: true, maxLength: 100 },
      razorpay_payment_id: { type: 'string', required: true, maxLength: 100 },
      razorpay_signature: { type: 'string', required: true, maxLength: 256 },
    },
  }),
  subscriptionController.verifyCheckout,
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
