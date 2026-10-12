/**
 * /api/v1/admin/entitlements routes (Phase 6 - implemented).
 *
 * PURPOSE
 *   Platform-admin entitlement surface (overrides + tenant usage +
 *   tenant entitlement inspection). Mounted under
 *   `/admin/entitlements`. Mutations require
 *   `billing.entitlements.override`; reads require
 *   `billing.entitlements.override` (admin-only — even read access
 *   to other tenants' entitlement state is admin-only).
 *
 * ENDPOINTS
 *   - GET  /overrides                          list all overrides
 *   - GET  /overrides/:tenantId                list overrides for a tenant
 *   - POST /overrides/:tenantId                create an override
 *   - POST /overrides/:id/revoke               revoke an override
 *   - GET  /tenants/:tenantId                  resolved entitlement
 *   - GET  /usage/:tenantId                    tenant usage map
 *
 * SECURITY
 *   - All routes require `adminAuth` AND a `billing.entitlements.override`
 *     permission. The default support role is read-only on the existing
 *     audit/compliance surfaces and remains read-only here; the override
 *     keys are NOT granted to the default support role.
 *   - Override writes require a non-empty `reason` and are audit-logged
 *     (actor / target / metric / kind / value / reason / occurredAt).
 *   - The safety-net clamp (`OVERRIDE_SAFETY_FACTOR`) is enforced in
 *     the service; the route is intentionally thin.
 *   - The `ci:routes-exempt` annotation sits on the `router.<verb>(`
 *     line itself so the `check-routes` CI guard sees it inside the
 *     captured args; the file-level `adminAuth` is the auth gate.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import entitlementValidator from '../validators/entitlement.validator.js';
import adminEntitlementController from '../controllers/adminEntitlement.controller.js';

const router = Router();
router.use(adminAuth);

router.get( // ci:routes-exempt: adminAuth above
  '/overrides',
  permission('billing.entitlements', 'override'),
  validate(entitlementValidator.adminListOverridesSchema),
  adminEntitlementController.listAllOverrides,
);

router.get( // ci:routes-exempt: adminAuth above
  '/overrides/:tenantId',
  permission('billing.entitlements', 'override'),
  validate(entitlementValidator.tenantOverridesSchema),
  adminEntitlementController.listTenantOverrides,
);

router.post( // ci:routes-exempt: adminAuth above
  '/overrides/:tenantId',
  permission('billing.entitlements', 'override'),
  validate(entitlementValidator.createOverrideSchema),
  adminEntitlementController.createOverride,
);

router.post( // ci:routes-exempt: adminAuth above
  '/overrides/:id/revoke',
  permission('billing.entitlements', 'override'),
  validate(entitlementValidator.revokeOverrideSchema),
  adminEntitlementController.revokeOverride,
);

router.get( // ci:routes-exempt: adminAuth above
  '/tenants/:tenantId',
  permission('billing.entitlements', 'override'),
  adminEntitlementController.getTenantEntitlements,
);

router.get( // ci:routes-exempt: adminAuth above
  '/usage/:tenantId',
  permission('billing.entitlements', 'override'),
  validate(entitlementValidator.adminUsageSchema),
  adminEntitlementController.getTenantUsage,
);

export default router;
