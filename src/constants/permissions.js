/**
 * Phase 6 permission key constants.
 *
 * WHY A CONSTANTS FILE
 *   Centralising the Phase 6 permission keys keeps the route file
 *   (subscription.routes.js, adminPlan.routes.js,
 *   adminSubscription.routes.js, adminEntitlement.routes.js) and
 *   the frontend permissions module (`src/lib/permissions/index.ts`)
 *   in lock-step. The keys MUST mirror the frontend constants
 *   exactly: any drift will surface as a 403 on a route the
 *   frontend thinks it can call.
 *
 * BACKEND REGISTRATION
 *   These permission keys are NOT auto-registered. The
 *   `tenantInitialization.ensurePermissions` flow seeds only the
 *   keys it knows about. Phase 6 introduces a new module
 *   `iam.subscriptions` and a new module `billing`; the modules
 *   themselves are NOT added to `BUILTIN_MODULES` (they are not
 *   permission *modules* in the same way `iam.users` is). Instead
 *   the role seed in `tenantInitialization.service.js` was extended
 *   to grant the `Owner` role the `iam.subscriptions.*` keys and
 *   the platform bootstrap service was extended to grant the
 *   `super` / `platform` roles the `billing.*` keys.
 *
 * FRONTEND MIRROR
 *   The frontend must add the same keys to
 *   `src/lib/permissions/index.ts` (see the Phase 6 frontend
 *   changes). The mirror is the source of truth on the client;
 *   the backend is the source of truth for authorization.
 */

export const Permissions = Object.freeze({
  // Workspace Owner self-service
  IAM_SUBSCRIPTIONS_VIEW: ['iam.subscriptions', 'view'],
  IAM_SUBSCRIPTIONS_UPDATE: ['iam.subscriptions', 'update'],
  IAM_ENTITLEMENTS_VIEW: ['iam.entitlements', 'view'],

  // Platform admin
  BILLING_PLANS_VIEW: ['billing.plans', 'view'],
  BILLING_PLANS_CREATE: ['billing.plans', 'create'],
  BILLING_PLANS_UPDATE: ['billing.plans', 'update'],
  BILLING_PLANS_ARCHIVE: ['billing.plans', 'archive'],
  BILLING_SUBSCRIPTIONS_VIEW: ['billing.subscriptions', 'view'],
  BILLING_SUBSCRIPTIONS_OVERRIDE: ['billing.subscriptions', 'override'],
  BILLING_ENTITLEMENTS_OVERRIDE: ['billing.entitlements', 'override'],
});

export const PERMISSION_MODULE_KEYS = Object.freeze([
  'iam.subscriptions',
  'iam.entitlements',
  'billing.plans',
  'billing.subscriptions',
  'billing.entitlements',
]);

export default Permissions;
