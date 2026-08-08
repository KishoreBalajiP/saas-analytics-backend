/**
 * Admin Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Business logic for Platform Admin authentication + lifecycle. Backs
 *   the `/admin` and `/admin-auth` HTTP surfaces. Login/refresh/logout
 *   delegate to the shared auth engine (`auth.service.js`, portal `admin`);
 *   everything else orchestrates `repositories/admin.repository.js`.
 *
 * RESPONSIBILITY
 *   - login / refresh / logout     -> auth engine delegation (portal admin)
 *   - list / create / getById / update
 *   - suspend / restore            -> also revokes the admin's sessions
 *   - assignRole / revokeRole      -> AdminRole grants + RBAC cache bump
 *
 * CODING GUIDELINES
 *   - Admins are PLATFORM-scoped; `tenantScope` is an optional escalation
 *     scope for `support` admins, not multi-tenancy scoping.
 *   - Throw `ApiError` factories for all expected failures.
 *   - Never log secrets; redact emails/PII in service logs.
 *   - Role-grant and suspend/restore mutations invalidate the RBAC cache
 *     for the affected scope so stale permission sets are never served.
 */

import ApiError from '../utils/ApiError.js';
import { hash as hashPassword } from '../utils/password.js';
import adminRepository from '../repositories/admin.repository.js';
import roleRepository from '../repositories/role.repository.js';
import authService from '../modules/iam/auth/auth.service.js';
import sessionService from '../modules/iam/auth/session.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { ADMIN_TYPES, ADMIN_STATUSES } from '../models/Admin.js';

const MIN_PASSWORD_LENGTH = 8;

/** Fields a caller may patch on an admin profile. */
const PROFILE_FIELDS = ['name', 'locale', 'timezone', 'avatarUrl'];

/* ------------------------------ auth surface ----------------------------- */

/**
 * Login a platform admin (delegates to the shared auth engine).
 *
 * @param {Object} opts - { email, password, mfaCode, ip, userAgent }.
 * @returns {Promise<Object>} `{ accessToken, expiresIn, refreshToken, sessionId, actor }`.
 */
export function login(opts) {
  return authService.login({ portal: 'admin', ...opts });
}

/**
 * Rotate an admin's refresh token (delegates to the shared auth engine).
 *
 * @param {Object} opts - { refreshToken, ip, userAgent }.
 * @returns {Promise<Object>}
 */
export function refresh(opts) {
  return authService.refresh(opts);
}

/**
 * Revoke the admin's session (delegates to the shared auth engine).
 *
 * @param {Object} opts - { refreshToken, sessionId }.
 * @returns {Promise<{ ok: boolean }>}
 */
export function logout(opts) {
  return authService.logoutByRefreshToken(opts);
}

/* ------------------------------- CRUD ----------------------------------- */

/**
 * Paginated admin list, filterable by status and/or adminType.
 *
 * @param {Object} [opts]
 * @param {'pending'|'active'|'suspended'|'locked'} [opts.status]
 * @param {'super'|'platform'|'support'} [opts.adminType]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated admin list.
 */
export async function list({ status, adminType, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (adminType) filter.adminType = adminType;
  return adminRepository.list({ filter, page, limit });
}

/**
 * Create a platform admin. The email must be globally unique (409), the
 * password must meet the minimum length, and `adminType` must be one of
 * the canonical types. Passwords are Argon2id-hashed before persistence.
 *
 * @param {Object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} [opts.adminType='platform']
 * @param {string} [opts.name='']
 * @param {string} [opts.tenantScope=null]
 * @param {'pending'|'active'} [opts.status='active']
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} saved admin (plain, secrets excluded).
 */
export async function create({
  email,
  password,
  adminType = 'platform',
  name = '',
  tenantScope = null,
  status = 'active',
  by = null,
} = {}) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) throw ApiError.badRequest('Email is required');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!ADMIN_TYPES.includes(adminType)) {
    throw ApiError.badRequest(`adminType must be one of ${ADMIN_TYPES.join(', ')}`);
  }
  if (status !== 'pending' && status !== 'active') {
    throw ApiError.badRequest('status must be "pending" or "active"');
  }

  const existing = await adminRepository.findByEmail(normalizedEmail);
  if (existing) throw ApiError.conflict('An admin with this email already exists');

  const passwordHash = await hashPassword(password);
  const admin = await adminRepository.create({
    email: normalizedEmail,
    passwordHash,
    adminType,
    status,
    tenantScope: tenantScope || null,
    profile: { name },
    createdBy: by,
  });
  return stripSecrets(admin);
}

/**
 * Get a single admin by id.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @returns {Promise<Object>}
 */
export async function getById({ id } = {}) {
  const admin = await adminRepository.findById(id);
  if (!admin) throw ApiError.notFound('Admin not found');
  return stripSecrets(admin);
}

/**
 * Update an admin's mutable fields (adminType, tenantScope, profile).
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {Object} [opts.patch={}]
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} updated admin (plain, secrets excluded).
 */
export async function update({ id, patch = {}, by = null } = {}) {
  const admin = await adminRepository.findById(id);
  if (!admin) throw ApiError.notFound('Admin not found');

  const set = {};
  if (patch.adminType !== undefined) {
    if (!ADMIN_TYPES.includes(patch.adminType)) {
      throw ApiError.badRequest(`adminType must be one of ${ADMIN_TYPES.join(', ')}`);
    }
    set.adminType = patch.adminType;
  }
  if (patch.tenantScope !== undefined) set.tenantScope = patch.tenantScope || null;
  for (const field of PROFILE_FIELDS) {
    if (patch[field] !== undefined) set[`profile.${field}`] = patch[field];
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

  const updated = await adminRepository.update(id, set, { by });
  return stripSecrets(updated);
}

/**
 * Suspend an admin and revoke every active session. Idempotent: an already
 * suspended admin resolves to success.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} updated admin (plain, secrets excluded).
 */
export async function suspend({ id, by = null } = {}) {
  const admin = await adminRepository.findById(id);
  if (!admin) throw ApiError.notFound('Admin not found');
  if (admin.status !== 'suspended') {
    await adminRepository.suspend(id, by);
    await sessionService.revokeAllForActor({ actorId: id, reason: 'admin_suspended' });
    await invalidateScope(admin.tenantScope ?? null);
  }
  const refreshed = await adminRepository.findById(id);
  return stripSecrets(refreshed);
}

/**
 * Restore a suspended admin.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} updated admin (plain, secrets excluded).
 */
export async function restore({ id, by = null } = {}) {
  const admin = await adminRepository.findById(id);
  if (!admin) throw ApiError.notFound('Admin not found');
  const restored = await adminRepository.restore(id, by);
  await invalidateScope(admin.tenantScope ?? null);
  return stripSecrets(restored);
}

/* ------------------------------ role grants ------------------------------ */

/**
 * Grant a role to an admin, optionally scoped to a support tenant.
 * Idempotent: an existing (adminId, roleId, tenantId) grant is a no-op.
 *
 * @param {Object} opts
 * @param {string} opts.adminId
 * @param {string} opts.roleId
 * @param {string|null} [opts.tenantId=null] - null = platform grant.
 * @param {string|null} [opts.by=null]
 * @param {string|null} [opts.expiresAt=null] - ISO date; must be in the future.
 * @returns {Promise<Object>} the grant row, or `{ alreadyAssigned: true }`.
 */
export async function assignRole({ adminId, roleId, tenantId = null, by = null, expiresAt = null } = {}) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');

  if (expiresAt) {
    const deadline = new Date(expiresAt);
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
      throw ApiError.badRequest('expiresAt must be a future date');
    }
  }

  const grant = await adminRepository.assignRole(adminId, roleId, { by, tenantId, expiresAt });
  await invalidateScope(tenantId ?? null);
  if (!grant) return { alreadyAssigned: true };
  return grant;
}

/**
 * Revoke a role grant from an admin. Idempotent: a missing grant resolves
 * to success with `removed: 0`.
 *
 * @param {Object} opts
 * @param {string} opts.adminId
 * @param {string} opts.roleId
 * @param {string|null} [opts.tenantId=null]
 * @returns {Promise<{ removed: number }>}
 */
export async function revokeRole({ adminId, roleId, tenantId = null } = {}) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');

  const removed = await adminRepository.revokeRole(adminId, roleId, { tenantId });
  await invalidateScope(tenantId ?? null);
  return { removed };
}

/* ------------------------------ internals -------------------------------- */

/** Strip secrets (passwordHash, mfaSecret) from a lean admin document. */
function stripSecrets(admin) {
  if (!admin) return admin;
  const { passwordHash, mfaSecret, ...safe } = admin;
  return safe;
}

export default {
  login,
  refresh,
  logout,
  list,
  create,
  getById,
  update,
  suspend,
  restore,
  assignRole,
  revokeRole,
  _meta: { portal: 'admin', stripSecrets: true, invalidatesCache: 'iam:rbac:<scope>' },
};
