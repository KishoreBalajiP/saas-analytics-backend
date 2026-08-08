/**
 * Role Repository (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for dynamic roles. Lives behind services
 *   so the storage backend can change without ripple.
 *
 * RESPONSIBILITY
 *   - findById, findByName, list, create, update, softDelete
 *   - attachPermission, detachPermission, listPermissionsForRole
 *   - countAssignments(roleId)    (used to refuse delete)
 *
 * CODING GUIDELINES
 *   - Lean returns everywhere.
 *   - `isSystem` protection lives in the service layer (this file only
 *     persists); the model's `{ tenantId, name }` unique index enforces
 *     name uniqueness per scope.
 *   - Permission membership lives in `RolePermission` join rows, never on
 *     the Role document.
 *
 * FUTURE EXTENSION
 *   - Hierarchical roles: child rows reference `parentId`.
 */

import { Role } from '../models/Role.js';
import { RolePermission } from '../models/RolePermission.js';
import { UserRole } from '../models/UserRole.js';
import { AdminRole } from '../models/AdminRole.js';
import { Permission } from '../models/Permission.js';

/** Find a role by id. Returns a lean object or null. */
export const findById = (id) => Role.findById(id).lean();

/**
 * Find a role by name within a scope. `tenantId === null` selects a
 * platform-level role; any other value selects within that tenant.
 */
export const findByName = ({ tenantId = null, name }) =>
  Role.findOne({ tenantId, name }).lean();

/** Paginated role list. `tenantId === null` lists platform roles. */
export const list = async ({ tenantId = null, filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await Role.paginate(
    { ...filter, tenantId },
    { page, limit, lean: true, sort: { createdAt: -1 } },
  );
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Create a role. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Role(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a role. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Role.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a role, recording the actor. Returns the plain doc or null. */
export const softDelete = async (id, by) => {
  const doc = await Role.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Remove every RolePermission membership row for a role (hard delete). */
export const clearPermissions = (roleId) => RolePermission.deleteMany({ roleId });

/**
 * Grant a permission to a role. Returns the new join row, or `null` when
 * the (role, permission) pair already exists.
 */
export const attachPermission = async (roleId, permissionId, grantedBy) => {
  try {
    const doc = new RolePermission({ roleId, permissionId, grantedBy });
    await doc.save();
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

/** Revoke a permission from a role. Returns the number of rows removed. */
export const detachPermission = (roleId, permissionId) =>
  RolePermission.deleteOne({ roleId, permissionId }).then((r) => r.deletedCount);

/** List the permissions a role holds (join via RolePermission). */
export const listPermissionsForRole = async (roleId) => {
  const joins = await RolePermission.find({ roleId }).select('permissionId grantedAt grantedBy').lean();
  if (joins.length === 0) return [];
  const ids = joins.map((j) => j.permissionId);
  const perms = await Permission.find({ _id: { $in: ids } }).lean();
  const byId = new Map(perms.map((p) => [p._id.toString(), p]));
  return joins
    .map((j) => ({ ...byId.get(j.permissionId.toString()), grantedAt: j.grantedAt, grantedBy: j.grantedBy }))
    .filter((p) => p._id);
};

/**
 * Count live user/admin assignments referencing the role. Used to refuse
 * deletion while a role is in use.
 */
export const countAssignments = async (roleId) => {
  const [userAssignments, adminAssignments] = await Promise.all([
    UserRole.countDocuments({ roleId }),
    AdminRole.countDocuments({ roleId }),
  ]);
  return userAssignments + adminAssignments;
};

/**
 * Resolve the role NAMES granted to an actor. Admin grants are scoped to
 * `tenantId` (null => platform grants); user grants are tenant-scoped.
 * Returns a Set of role names (empty when the actor has no grants).
 *
 * @param {Object} opts
 * @param {'admin'|'user'} opts.actorType
 * @param {string} opts.actorId
 * @param {string|null} [opts.tenantId=null]
 * @returns {Promise<Set<string>>}
 */
export const resolveRolesForActor = async ({ actorType, actorId, tenantId = null } = {}) => {
  const grants =
    actorType === 'admin'
      ? await AdminRole.find({ adminId: actorId, tenantId }).select('roleId').lean()
      : await UserRole.find({ tenantId, userId: actorId }).select('roleId').lean();
  if (grants.length === 0) return new Set();

  const ids = [...new Set(grants.map((g) => g.roleId))];
  const roles = await Role.find({ _id: { $in: ids } }).select('name').lean();
  return new Set(roles.map((r) => r.name));
};

/**
 * Resolve the role NAMES per user for a batch of userIds within a tenant.
 * Used by the tenant members view to avoid N+1 lookups.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string[]} opts.userIds
 * @returns {Promise<Map<string, string[]>>} userId -> sorted role names.
 */
export const resolveRolesForUsers = async ({ tenantId, userIds }) => {
  if (userIds.length === 0) return new Map();
  const grants = await UserRole.find({ tenantId, userId: { $in: userIds } }).select('userId roleId').lean();
  if (grants.length === 0) return new Map();
  const roleIds = [...new Set(grants.map((g) => g.roleId))];
  const roles = await Role.find({ _id: { $in: roleIds } }).select('_id name').lean();
  const roleNames = new Map(roles.map((r) => [r._id.toString(), r.name]));
  const byUser = new Map();
  for (const grant of grants) {
    const name = roleNames.get(grant.roleId.toString());
    if (!name) continue;
    const list = byUser.get(grant.userId) ?? [];
    if (!list.includes(name)) list.push(name);
    byUser.set(grant.userId, list);
  }
  for (const names of byUser.values()) names.sort();
  return byUser;
};

export default {
  findById,
  findByName,
  list,
  create,
  update,
  softDelete,
  clearPermissions,
  attachPermission,
  detachPermission,
  listPermissionsForRole,
  countAssignments,
  resolveRolesForActor,
  resolveRolesForUsers,
  _meta: { leanReturns: true, systemRolesProtected: true, membership: 'RolePermission join rows' },
};
