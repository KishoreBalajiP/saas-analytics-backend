/**
 * /api/v1/admin/entitlements routes (Phase 6 - implemented).
 *
 * PURPOSE
 *   Platform-admin entitlement surface (overrides + tenant usage +
 *   tenant entitlement inspection). Mounted under
 *   `/admin/entitlements`. Mutations require
 *   `billing.entitlements.override`; reads require
 *   `billing.entitlements.view` (roadmap 2.1: platform admins and auditors
 *   can inspect entitlements without being able to override them).
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
 *   - All routes require `adminAuth` AND a `billing.entitlements.*`
 *     permission (`view` for reads, `override` for writes), plus an
 *     `adminScope` guard: tenant-scoped admins only reach their own tenant,
 *     the cross-tenant list is clamped to the scope, and revoking an
 *     override by id is platform-only. Overrides are super-admin only in
 *     the built-in role catalogue (`constants/platformRoles.js`).
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
import { adminScope } from '../middleware/adminScope.middleware.js';
import { validate } from '../validators/index.js';
import entitlementValidator from '../validators/entitlement.validator.js';
import adminEntitlementController from '../controllers/adminEntitlement.controller.js';

const router = Router();
router.use(adminAuth);

router.get( // ci:routes-exempt: adminAuth above
  '/overrides',
  permission('billing.entitlements', 'view'),
  adminScope.filtered(),
  validate(entitlementValidator.adminListOverridesSchema),
  adminEntitlementController.listAllOverrides,
);

router.get( // ci:routes-exempt: adminAuth above
  '/overrides/:tenantId',
  permission('billing.entitlements', 'view'),
  adminScope.tenant((req) => req.params.tenantId),
  validate(entitlementValidator.tenantOverridesSchema),
  adminEntitlementController.listTenantOverrides,
);

router.post( // ci:routes-exempt: adminAuth above
  '/overrides/:tenantId',
  permission('billing.entitlements', 'override'),
  adminScope.tenant((req) => req.params.tenantId),
  validate(entitlementValidator.createOverrideSchema),
  adminEntitlementController.createOverride,
);

router.post( // ci:routes-exempt: adminAuth above
  '/overrides/:id/revoke',
  permission('billing.entitlements', 'override'),
  adminScope.platform(),
  validate(entitlementValidator.revokeOverrideSchema),
  adminEntitlementController.revokeOverride,
);

router.get( // ci:routes-exempt: adminAuth above
  '/tenants/:tenantId',
  permission('billing.entitlements', 'view'),
  adminScope.tenant((req) => req.params.tenantId),
  adminEntitlementController.getTenantEntitlements,
);

router.get( // ci:routes-exempt: adminAuth above
  '/usage/:tenantId',
  permission('billing.entitlements', 'view'),
  adminScope.tenant((req) => req.params.tenantId),
  validate(entitlementValidator.adminUsageSchema),
  adminEntitlementController.getTenantUsage,
);

export default router;
