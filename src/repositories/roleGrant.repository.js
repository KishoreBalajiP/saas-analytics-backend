/**
 * Role Grant Repository (auth hardening).
 *
 * PURPOSE
 *   Expiry lookups over an actor's role grants (`UserRole` / `AdminRole`).
 *   The RBAC cache uses it to bound how long a resolved role/permission set
 *   may be reused: never past the moment the earliest live grant expires.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findEarliestGrantExpiry({ actorType, actorId, tenantId, now })
 *
 * CODING GUIDELINES
 *   - Same grant scoping as the resolvers in `permission.repository.js` and
 *     `role.repository.js`: an admin's effective grants are its platform
 *     grants (`tenantId: null`) plus, for an admin confined to a tenant
 *     (`tenantScope`), the grants scoped to that tenant
 *     (`adminGrantTenantFilter`); user grants by `{ tenantId, userId }`.
 *   - Reads are lean and project only `expiresAt`.
 */

import { UserRole } from '../models/UserRole.js';
import { AdminRole } from '../models/AdminRole.js';

/**
 * `AdminRole.tenantId` filter for an admin's effective grants. `scope` is the
 * admin's `tenantScope` (null for a platform-wide admin): platform grants
 * always count, and a scoped admin's grants for its own tenant count too.
 * Grants scoped to any other tenant never count.
 *
 * @param {string|null|undefined} scope
 * @returns {null|{ $in: Array<string|null> }}
 */
export function adminGrantTenantFilter(scope) {
  return scope ? { $in: [null, String(scope)] } : null;
}

/**
 * Earliest `expiresAt` among the actor's grants that are still live at
 * `now`, or `null` when none of them expires.
 *
 * @param {Object} opts
 * @param {'admin'|'user'} opts.actorType
 * @param {string} opts.actorId
 * @param {string|null} [opts.tenantId=null]
 * @param {Date} [opts.now=new Date()]
 * @returns {Promise<Date|null>}
 */
export const findEarliestGrantExpiry = async ({ actorType, actorId, tenantId = null, now = new Date() }) => {
  const filter = actorType === 'admin'
    ? { adminId: actorId, tenantId: adminGrantTenantFilter(tenantId), expiresAt: { $gt: now } }
    : { tenantId, userId: actorId, expiresAt: { $gt: now } };
  const Model = actorType === 'admin' ? AdminRole : UserRole;
  const next = await Model.findOne(filter).sort({ expiresAt: 1 }).select('expiresAt').lean();
  return next?.expiresAt ? new Date(next.expiresAt) : null;
};

export default {
  findEarliestGrantExpiry,
  adminGrantTenantFilter,
  _meta: { leanReturns: true, purpose: 'rbac-cache-expiry-bound' },
};
