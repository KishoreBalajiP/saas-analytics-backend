/**
 * adminScope.middleware.js (roadmap 2.1 - platform role model).
 *
 * PURPOSE
 *   Confines a tenant-scoped platform admin to its tenant on every platform
 *   route. An admin's scope is its LIVE `Admin.tenantScope`, which
 *   `adminAuth` exposes as `req.admin.tenantId` (null = platform-wide).
 *   Permissions say WHAT an admin may do; this middleware says WHERE.
 *
 * MODES (every admin route declares exactly one, after `permission(...)`)
 *   - `adminScope.platform()`  platform-wide surface (administrators, roles,
 *     the permission catalogue, master data, plans, monitoring, access
 *     requests). Tenant-scoped admins are refused.
 *   - `adminScope.tenant(read?)`  the route targets ONE tenant, read from
 *     the request (default `req.params.id ?? req.params.tenantId`). A scoped
 *     admin may only target its own tenant.
 *   - `adminScope.filtered(read?)`  lists and look-ups whose handler clamps
 *     its query to `req.adminScope.tenantId` (and checks loaded resources
 *     with `assertResourceInScope`). An explicit tenant filter outside the
 *     scope (default `query.tenantId ?? body.tenantId`) is refused up front.
 *
 *   Every mode attaches `req.adminScope = { tenantId, scoped }`.
 *
 * SECURITY RULES
 *   - Runs AFTER `adminAuth` (needs `req.admin`); fails closed without it.
 *   - Refusals are 403 `ADMIN_SCOPE_DENIED`. Resources loaded by id that
 *     belong to another tenant answer 404 (existence is not disclosed).
 *   - Every refusal (403 and the out-of-scope 404) is recorded as a
 *     rate-limited `request.denied` security event with reason
 *     `admin_scope` (roadmap 2.5, `audit.middleware.js#auditDenied`),
 *     naming the tenant the admin tried to reach.
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import { CROSS_TENANT_SCOPE } from './tenantIsolation.middleware.js';
import { auditDenied } from './audit.middleware.js';

function scopeDenied(message) {
  const err = ApiError.forbidden(message);
  err.code = ERROR_CODES.ADMIN_SCOPE_DENIED;
  return err;
}

/** Audit a scope refusal (request.denied, reason `admin_scope`) and return `err`. */
function denied(req, err, requestedTenantIds = [], details = {}) {
  const list = Array.isArray(requestedTenantIds) ? requestedTenantIds : [requestedTenantIds];
  const scope = adminScopeOf(req);
  const outside = list.map((id) => (id == null ? '' : String(id))).find((id) => id && id !== scope);
  return auditDenied(req, err, 'admin_scope', {
    ...(outside ? { requestedTenantId: outside } : {}),
    adminScopeTenantId: scope,
    ...details,
  });
}

/**
 * The admin's tenant boundary (null = platform-wide). The cross-tenant
 * scope `*` (`tenantIsolation`'s CROSS_TENANT_SCOPE) reaches every tenant,
 * so it is platform-wide here too, never a tenant called "*".
 */
export function adminScopeOf(req) {
  const value = req?.admin?.tenantId;
  if (!value || String(value) === CROSS_TENANT_SCOPE) return null;
  return String(value);
}

/** Normalise a reader's result to a list of non-empty tenant ids. */
function asTenantList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => item !== undefined && item !== null && item !== '').map(String);
}

function attach(req) {
  const tenantId = adminScopeOf(req);
  req.adminScope = { tenantId, scoped: tenantId !== null };
  return tenantId;
}

function requireAdmin(req) {
  return Boolean(req?.admin?.id);
}

/** Refuse tenant-scoped admins on a platform-wide route. */
function platform() {
  return function adminScopePlatform(req, _res, next) {
    if (!requireAdmin(req)) return next(auditDenied(req, ApiError.forbidden('Platform admin identity is required'), 'no_identity'));
    const scope = attach(req);
    if (scope) {
      return next(denied(req, scopeDenied('This action is not available to tenant-scoped administrators'), [], { mode: 'platform' }));
    }
    return next();
  };
}

const defaultTenantReader = (req) => req.params?.id ?? req.params?.tenantId ?? null;

/** Allow a scoped admin to target only its own tenant. */
function tenant(readTenantId = defaultTenantReader) {
  return function adminScopeTenant(req, _res, next) {
    if (!requireAdmin(req)) return next(auditDenied(req, ApiError.forbidden('Platform admin identity is required'), 'no_identity'));
    const scope = attach(req);
    if (!scope) return next();
    const requested = asTenantList(readTenantId(req));
    if (requested.length === 0 || requested.some((id) => id !== scope)) {
      return next(denied(req, scopeDenied('Your scope does not cover this tenant'), requested, { mode: 'tenant' }));
    }
    return next();
  };
}

const defaultFilterReader = (req) => req.query?.tenantId ?? req.body?.tenantId ?? null;

/** Lists/look-ups: refuse an explicit out-of-scope tenant filter. */
function filtered(readTenantId = defaultFilterReader) {
  return function adminScopeFiltered(req, _res, next) {
    if (!requireAdmin(req)) return next(auditDenied(req, ApiError.forbidden('Platform admin identity is required'), 'no_identity'));
    const scope = attach(req);
    if (!scope) return next();
    const requested = asTenantList(readTenantId(req));
    if (requested.some((id) => id !== scope)) {
      return next(denied(req, scopeDenied('Your scope does not cover this tenant'), requested, { mode: 'filtered' }));
    }
    return next();
  };
}

/**
 * The tenant filter a handler must use: the admin's scope when scoped
 * (refusing a different explicit filter), otherwise the caller's filter.
 *
 * @param {import('express').Request} req
 * @param {string|null|undefined} requested - caller-supplied tenant filter.
 * @returns {string|undefined}
 */
export function clampTenantFilter(req, requested) {
  const scope = adminScopeOf(req);
  if (!scope) return requested ?? undefined;
  if (requested && String(requested) !== scope) {
    throw denied(req, scopeDenied('Your scope does not cover this tenant'), [requested], { mode: 'clamp' });
  }
  return scope;
}

/**
 * Throw 404 when a loaded resource belongs outside a scoped admin's tenant.
 * `resourceTenantIds` is the resource's tenant id (or list of tenant ids).
 *
 * @param {import('express').Request} req
 * @param {string|string[]|null|undefined} resourceTenantIds
 * @param {string} [message='Resource not found']
 */
export function assertResourceInScope(req, resourceTenantIds, message = 'Resource not found') {
  const scope = adminScopeOf(req);
  if (!scope) return;
  const owners = asTenantList(resourceTenantIds);
  if (!owners.includes(scope)) {
    throw auditDenied(req, ApiError.notFound(message), 'admin_scope', {
      ...(owners[0] ? { requestedTenantId: owners[0] } : {}),
      adminScopeTenantId: scope,
      mode: 'resource',
    });
  }
}

export const adminScope = Object.freeze({ platform, tenant, filtered });

export default {
  adminScope,
  adminScopeOf,
  clampTenantFilter,
  assertResourceInScope,
  _meta: {
    phase: 'roadmap 2.1',
    runOrder: 'after adminAuth and permission(), before validate()',
    errorCode: ERROR_CODES.ADMIN_SCOPE_DENIED,
  },
};
