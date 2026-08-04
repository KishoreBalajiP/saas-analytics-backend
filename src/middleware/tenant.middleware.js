/**
 * Tenant resolution middleware (foundation shell).
 *
 * WHY IT EXISTS
 *   This is a multi-tenant SaaS platform. Every tenant-scoped request must
 *   be bound to a tenant before any data access happens. The mechanism is
 *   established now so feature teams build against a stable contract.
 *
 * RESPONSIBILITY
 *   Currently it FAILS CLOSED (501) exactly like auth. When implemented it
 *   will resolve the tenant from (in priority order):
 *     - `X-Tenant-Id` header (service-to-service / embedded widgets), or
 *     - a `tenantId` claim inside the JWT, or
 *     - a subdomain (e.g. `acme.app.com`).
 *   and attach `req.tenant = { id }`, later used by a Mongoose plugin to
 *   scope every query automatically.
 *
 * HOW TO EXTEND
 *   Replace the body when the tenants module lands. Keep the rule that
 *   tenant-scoped data is NEVER accessible without a resolved tenant.
 */

import ApiError from '../utils/ApiError.js';

/**
 * Resolve the tenant for the current request. Not implemented - fails closed.
 * Intended usage: `router.use(resolveTenant)` inside tenant-scoped routers.
 */
export function resolveTenant(_req, _res, next) {
  return next(
    new ApiError(501, 'Tenant resolution is not implemented yet', {
      code: 'TENANT_NOT_IMPLEMENTED',
    }),
  );
}

/**
 * Read the resolved tenant id off the request.
 * @returns {string|null} the tenant id or null when not resolved yet.
 */
export function getTenantId(req) {
  return req.tenant?.id ?? null;
}
