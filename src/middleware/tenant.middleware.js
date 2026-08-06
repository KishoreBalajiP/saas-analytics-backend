/**
 * Tenant resolution middleware (Sprint 1 - implemented).
 *
 * WHY IT EXISTS
 *   This is a multi-tenant SaaS platform. Tenant-scoped requests (login,
 *   password reset, user lookups) must be bound to a tenant before any data
 *   access happens. The mechanism is stable now so feature teams build
 *   against a fixed contract.
 *
 * RESPONSIBILITY
 *   Resolve the tenant for the current request in priority order:
 *     1. `X-Tenant-Id` header (service-to-service / embedded widgets), then
 *     2. the `tenantId` claim inside the (already verified) JWT.
 *   and attach `req.tenant = { id }`. Subdomain resolution is deferred to
 *   Phase 4 (see Sprint 1 risk 4) - Sprint 1 only reads the header + claim.
 *
 * SECURITY RULE
 *   Fail closed: tenant-scoped data is NEVER reachable without a resolved
 *   tenant, so a request that resolves no tenant is rejected.
 */

import ApiError from '../utils/ApiError.js';

/**
 * Resolve the tenant for the current request. Fails closed when no tenant
 * can be derived.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function resolveTenant(req, _res, next) {
  const header = req.headers?.['x-tenant-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    req.tenant = { id: header.trim(), source: 'header' };
    return next();
  }

  const claim = req.user?.tenantId ?? req.admin?.tenantId ?? null;
  if (claim) {
    req.tenant = { id: claim, source: 'jwt' };
    return next();
  }

  return next(ApiError.badRequest('Tenant id is required'));
}

/**
 * Read the resolved tenant id off the request.
 * @returns {string|null} the tenant id or null when not resolved yet.
 */
export function getTenantId(req) {
  return req.tenant?.id ?? null;
}

export default { resolveTenant, getTenantId };
