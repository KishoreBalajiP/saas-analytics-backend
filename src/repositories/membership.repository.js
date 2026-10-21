/**
 * Membership Repository (roadmap 2.10).
 *
 * PURPOSE
 *   Data access for a tenant member's role grants (`UserRole`) and the member
 *   facts the membership rules need (role holders, active owners, member
 *   counts per role). The tenant member/role services build on it.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - listRoleIdsForUser, listRoleIdsForUsers
 *   - addGrant, removeGrants, removeAllGrants
 *   - listHolderIds, countActiveHolders, countHoldersByRole
 *
 * CODING GUIDELINES
 *   - Every query filters by `tenantId` explicitly.
 *   - Only live, unscoped grants count: not expired (`expiresAt` null or in
 *     the future), not soft-deleted, and without a resource scope. Scoped
 *     grants are left untouched by the member APIs.
 *   - Lean returns.
 */

import { UserRole } from '../models/UserRole.js';
import { User } from '../models/User.js';

/** Filter for grants that count right now. */
function liveGrant(now = new Date()) {
  return {
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    'scope.resourceType': null,
    'scope.resourceId': null,
  };
}

function requireTenant(tenantId) {
  if (!tenantId) throw new Error('membership.repository: tenantId is required');
  return String(tenantId);
}

/** Role ids a member holds (live, unscoped grants). */
export const listRoleIdsForUser = async ({ tenantId, userId }) => {
  const rows = await UserRole.find({ tenantId: requireTenant(tenantId), userId: String(userId), ...liveGrant() })
    .select('roleId')
    .lean();
  return [...new Set(rows.map((r) => String(r.roleId)))];
};

/** userId -> role ids, for a page of members (one query). */
export const listRoleIdsForUsers = async ({ tenantId, userIds }) => {
  const out = new Map();
  if (!userIds?.length) return out;
  const rows = await UserRole.find({
    tenantId: requireTenant(tenantId),
    userId: { $in: userIds.map(String) },
    ...liveGrant(),
  })
    .select('userId roleId')
    .lean();
  for (const row of rows) {
    const list = out.get(String(row.userId)) ?? [];
    if (!list.includes(String(row.roleId))) list.push(String(row.roleId));
    out.set(String(row.userId), list);
  }
  return out;
};

/**
 * Grant a role (unscoped, permanent). Idempotent: an existing grant is kept.
 *
 * @returns {Promise<boolean>} true when a new grant was written.
 */
export const addGrant = async ({ tenantId, userId, roleId, by = null }) => {
  try {
    await new UserRole({
      tenantId: requireTenant(tenantId),
      userId: String(userId),
      roleId: String(roleId),
      grantedBy: by ? String(by) : null,
      grantedAt: new Date(),
    }).save();
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
};

/** Remove the given unscoped grants of a member. Returns the removed count. */
export const removeGrants = async ({ tenantId, userId, roleIds }) => {
  if (!roleIds?.length) return 0;
  const res = await UserRole.deleteMany({
    tenantId: requireTenant(tenantId),
    userId: String(userId),
    roleId: { $in: roleIds.map(String) },
    'scope.resourceType': null,
    'scope.resourceId': null,
  });
  return res.deletedCount ?? 0;
};

/** Remove every grant (scoped or not) of a member. Returns the removed count. */
export const removeAllGrants = async ({ tenantId, userId }) => {
  const res = await UserRole.deleteMany({ tenantId: requireTenant(tenantId), userId: String(userId) });
  return res.deletedCount ?? 0;
};

/** User ids holding a role (live, unscoped grants). */
export const listHolderIds = async ({ tenantId, roleId }) => {
  const rows = await UserRole.find({ tenantId: requireTenant(tenantId), roleId: String(roleId), ...liveGrant() })
    .select('userId')
    .lean();
  return [...new Set(rows.map((r) => String(r.userId)))];
};

/**
 * Members holding a role whose account is `active` (and not removed),
 * optionally ignoring some users (e.g. the member being changed).
 */
export const countActiveHolders = async ({ tenantId, roleId, excludeUserIds = [] }) => {
  const exclude = new Set(excludeUserIds.map(String));
  const ids = (await listHolderIds({ tenantId, roleId })).filter((id) => !exclude.has(id));
  if (ids.length === 0) return 0;
  return User.countDocuments({ _id: { $in: ids }, tenantId: requireTenant(tenantId), status: 'active' });
};

/** roleId -> number of members (not removed) holding it, for the roles page. */
export const countHoldersByRole = async ({ tenantId, roleIds }) => {
  const out = new Map();
  if (!roleIds?.length) return out;
  const rows = await UserRole.find({
    tenantId: requireTenant(tenantId),
    roleId: { $in: roleIds.map(String) },
    ...liveGrant(),
  })
    .select('userId roleId')
    .lean();
  if (rows.length === 0) return out;
  const userIds = [...new Set(rows.map((r) => String(r.userId)))];
  const live = await User.find({ _id: { $in: userIds }, tenantId: requireTenant(tenantId) }).select('_id').lean();
  const liveIds = new Set(live.map((u) => String(u._id)));
  for (const row of rows) {
    if (!liveIds.has(String(row.userId))) continue;
    out.set(String(row.roleId), (out.get(String(row.roleId)) ?? 0) + 1);
  }
  return out;
};

export default {
  listRoleIdsForUser,
  listRoleIdsForUsers,
  addGrant,
  removeGrants,
  removeAllGrants,
  listHolderIds,
  countActiveHolders,
  countHoldersByRole,
  _meta: { leanReturns: true, tenancy: 'tenant', grants: 'live, unscoped UserRole rows' },
};
