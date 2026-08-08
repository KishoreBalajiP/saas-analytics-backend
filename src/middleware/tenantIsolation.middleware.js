/**
 * tenantIsolation.middleware.js (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Strict enforcement of the multi-tenant boundary. Runs AFTER `adminAuth`
 *   (or tenant `auth`) and AFTER `tenant.middleware.js` (which resolves
 *   `req.tenant`). Refuses any request that accesses a tenant the actor
 *   cannot reach.
 *
 * RESPONSIBILITY
 *   - Derive the requested tenantId (`params.tenantId` / `body.tenantId` /
 *     `query.tenantId` / resolved `req.tenant.id`).
 *   - User actors: the requested tenant MUST equal their home tenant.
 *   - Admin actors: allowed when their `tenantScope` claim is `'*'` (full
 *     cross-tenant) or exactly matches the requested tenant (scoped support).
 *     Platform admins without an explicit scope are refused on tenant-scoped
 *     requests - they manage tenants through the `/admin` surface instead.
 *
 * DESIGN PRINCIPLES
 *   - **Default deny.** No request bypasses unless the actor has explicit
 *     cross-tenant scope (`tenantScope: '*'`) or a matching scoped grant.
 *   - **Combine with `tenant.middleware.js`.** Resolution (which tenant?)
 *     comes from `tenant.middleware.js`; isolation (can the actor reach
 *     this tenant?) comes from THIS middleware. Two-step split keeps both
 *     single-purpose.
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';

/** Wildcard tenantScope meaning "may reach any tenant". */
export const CROSS_TENANT_SCOPE = '*';

/** Default way to find the tenant this request is trying to reach. */
export function readRequestedTenantId(req) {
  return (
    req.params?.tenantId ??
    req.body?.tenantId ??
    req.query?.tenantId ??
    req.tenant?.id ??
    null
  );
}

/**
 * Factory: refuse 403 when the request targets a tenant the actor cannot
 * reach. `opts.readTenantId(req)` overrides how the requested tenant is
 * derived (default `readRequestedTenantId`).
 *
 * @param {Object} [opts]
 * @param {(req) => string|null} [opts.readTenantId]
 * @returns {import('express').RequestHandler}
 */
export function tenantIsolation(opts = {}) {
  const readTenantId = opts.readTenantId ?? readRequestedTenantId;
  return (req, _res, next) => {
    const requested = readTenantId(req);
    if (!requested) return next();

    const actor = getActor(req);
    if (!actor) return next(ApiError.forbidden('Authenticated identity is required'));

    if (actor.type === 'user') {
      if (actor.tenantId && actor.tenantId === requested) return next();
      return next(ApiError.forbidden('You cannot access data from another tenant'));
    }

    // Admin: '*' scope reaches anything; otherwise the scoped grant must match.
    if (actor.tenantId === CROSS_TENANT_SCOPE || actor.tenantId === requested) return next();
    return next(ApiError.forbidden('Your scope does not cover this tenant'));
  };
}

/**
 * Variant for queue workers / background jobs that already carry a scope
 * object. Returns a guard `(scope) => void` that throws `ApiError.forbidden`
 * unless `scope.tenantId` matches `opts.tenantId` (or `opts.tenantId === '*'`).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId - allowed tenant, or `'*'` for any.
 * @returns {(scope: { tenantId?: string|null }) => void}
 */
export function tenantIsolationForJob(opts = {}) {
  const allowed = opts.tenantId ?? null;
  return (scope = {}) => {
    const target = scope.tenantId ?? null;
    if (allowed === CROSS_TENANT_SCOPE) return;
    if (allowed && allowed === target) return;
    throw ApiError.forbidden('Job scope does not cover this tenant');
  };
}

export default {
  tenantIsolation,
  tenantIsolationForJob,
  CROSS_TENANT_SCOPE,
  readRequestedTenantId,
  _meta: {
    phase: '2 - implemented',
    runOrder: 'after adminAuth / auth, after tenant.middleware.js',
    seeAlso: ['src/middleware/tenant.middleware.js'],
  },
};
