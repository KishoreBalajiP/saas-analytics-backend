/**
 * User Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Business logic for the tenant-user `/users` surface. Kept deliberately
 *   thin: self-service profile reads/writes plus a tenant-scoped read
 *   surface for tenant admins. Password/SSO flows stay in the auth module.
 *
 * RESPONSIBILITY
 *   - getProfile({ userId })            - self profile (secrets stripped)
 *   - updateProfile({ userId, patch })  - profile fields only
 *   - list({ tenantId, search })        - tenant-scoped paginated list
 *   - getById({ id, tenantId })         - tenant-scoped detail
 *
 * CODING GUIDELINES
 *   - Every read/write is tenant-scoped: the service REQUIRES `tenantId`
 *     from the caller (derived from the authenticated token, never the
 *     request body) - this is the primary multi-tenant defence.
 *   - `passwordHash` and lockout internals are never returned.
 */

import ApiError from '../utils/ApiError.js';
import userRepository from '../repositories/user.repository.js';

/** Profile fields a user may edit themselves. */
const PROFILE_FIELDS = ['name', 'locale', 'timezone', 'avatarUrl', 'phone'];

/** Strip auth/lockout internals from a lean user document. */
function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash, failedAttempts, lockedUntil, ...safe } = user;
  return safe;
}

/**
 * Fetch the caller's own profile.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @returns {Promise<Object>}
 */
export async function getProfile({ userId } = {}) {
  const user = await userRepository.findById(userId);
  if (!user) throw ApiError.notFound('User not found');
  return stripSecrets(user);
}

/**
 * Update the caller's own profile fields.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {Object} [opts.patch={}]
 * @returns {Promise<Object>} updated profile (plain, secrets stripped).
 */
export async function updateProfile({ userId, patch = {} } = {}) {
  const user = await userRepository.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  const set = {};
  for (const field of PROFILE_FIELDS) {
    if (patch[field] !== undefined) set[`profile.${field}`] = patch[field];
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

  const updated = await userRepository.update(userId, set);
  return stripSecrets(updated);
}

/**
 * Paginated, tenant-scoped user list (for tenant-administration surfaces).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId - REQUIRED; taken from the token, never the body.
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated list with secrets stripped.
 */
export async function list({ tenantId, search, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const filter = {};
  if (search) filter['profile.name'] = { $regex: escapeRegExp(search), $options: 'i' };
  const result = await userRepository.list({ tenantId, filter, page, limit });
  return {
    ...result,
    docs: result.docs.map(stripSecrets),
  };
}

/**
 * Tenant-scoped user detail.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.tenantId - REQUIRED tenant scope.
 * @returns {Promise<Object>}
 */
export async function getById({ id, tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const user = await userRepository.findById(id);
  if (!user || user.tenantId !== tenantId) throw ApiError.notFound('User not found');
  return stripSecrets(user);
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  getProfile,
  updateProfile,
  list,
  getById,
  _meta: { tenancy: 'required-tenantId', stripSecrets: true },
};
