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
 *   - adminauth (roadmap 2.2): invite / resendInvitation / revokeInvitation
 *     / listInvitations. The HTTP surface invites (no password typed by the
 *     inviter); `create` with a password remains for internal provisioning
 *     (bootstrap, migrations, test fixtures) and is not mounted on a route.
 *
 * CODING GUIDELINES
 *   - Admins are PLATFORM-scoped; `tenantScope` optionally confines an
 *     admin to one tenant (enforced by `middleware/adminScope.middleware.js`).
 *   - Throw `ApiError` factories for all expected failures.
 *   - Never log secrets; redact emails/PII in service logs.
 *   - Role-grant and suspend/restore mutations invalidate the RBAC cache
 *     for the affected scope so stale permission sets are never served.
 *   - Privilege changes are security events: role grants/revocations
 *     (`rbac.role.*`), admin creation and adminType/tenantScope changes
 *     (`admin.privilege.changed`), and refused privilege changes
 *     (`admin.privilege.change_denied`).
 *
 * PRIVILEGE RULES (roadmap 2.1, audit doc 05 section 4)
 *   - Nobody changes their own privileges; only an active super admin
 *     changes anyone's (roles, adminType, tenantScope, creating supers).
 *   - Only an active super admin may manage (update, suspend, restore) a
 *     super admin: platform admins cannot manage super admins.
 *   - `adminType` is the ceiling: built-in platform roles above it cannot be
 *     granted, and lowering the type revokes built-in roles above it.
 *     Legacy all-permission bootstrap roles can no longer be granted.
 *   - A tenant-scoped grant is only accepted for an admin confined to that
 *     tenant (`tenantScope`), so a grant never silently does nothing.
 *   - The platform always keeps one active super admin: suspension and
 *     demotion use a compare-and-set write followed by a re-count with a
 *     compensating undo (`changeSuperSafely`), which stays correct under
 *     concurrent requests without transactions; revoking the last live
 *     super-admin role grant is refused the same way.
 */

import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import { hash as hashPassword } from '../utils/password.js';
import adminRepository from '../repositories/admin.repository.js';
import roleRepository from '../repositories/role.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import authService from '../modules/iam/auth/auth.service.js';
import sessionService from '../modules/iam/auth/session.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { ADMIN_TYPES, ADMIN_STATUSES } from '../models/Admin.js';
import adminInvitationService from './adminInvitation.service.js';
import { securityEvent } from './securityEvent.service.js';
import {
  ADMIN_TYPE_RANK,
  LEGACY_PLATFORM_ROLE_NAMES,
  PLATFORM_ROLE_NAMES,
  findPlatformRole,
  isBuiltInPlatformRole,
} from '../constants/platformRoles.js';

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
  return authService.refresh({ ...opts, portal: 'admin' });
}

/**
 * Revoke the admin's session (delegates to the shared auth engine).
 *
 * @param {Object} opts - { refreshToken, sessionId }.
 * @returns {Promise<{ ok: boolean, revoked: boolean }>}
 */
export function logout(opts) {
  return authService.logoutByRefreshToken({ ...opts, portal: 'admin' });
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
  const result = await adminRepository.list({ filter, page, limit });
  // Never return credential material from list reads (the repository
  // returns raw lean documents).
  return { ...result, docs: result.docs.map(stripSecrets) };
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

  if (adminType === 'super' || tenantScope) await assertMayChangePrivileges({ by });
  if (tenantScope) await assertScopeTenantExists({ tenantScope, by });

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
  await securityEvent('ADMIN_PRIVILEGE_CHANGED', {
    tenantId: null,
    resource: { type: 'admin', id: String(admin._id) },
    metadata: {
      operation: 'create',
      adminId: String(admin._id),
      email: normalizedEmail,
      changes: { adminType: { from: null, to: adminType }, tenantScope: { from: null, to: tenantScope || null } },
    },
  });
  return stripSecrets(admin);
}

/* ------------------------- adminauth: invitations ------------------------ */

/**
 * Invite a platform admin by email (finding adm.09). Creates the admin in
 * status `pending` WITHOUT a password - it cannot sign in - and emails a
 * one-time acceptance link. Inviting a `super` admin, or one with a support
 * tenant scope, is a privilege change: only an active super admin may do it
 * (and the route requires a fresh step-up for `super`).
 *
 * @param {Object} opts
 * @param {string} opts.email
 * @param {string} [opts.adminType='platform']
 * @param {string} [opts.name='']
 * @param {string|null} [opts.tenantScope=null]
 * @param {string|null} [opts.by=null] - inviting admin id.
 * @returns {Promise<{ admin: Object, invitation: Object, delivered: boolean }>}
 */
export async function invite({ email, adminType = 'platform', name = '', tenantScope = null, by = null } = {}) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) throw ApiError.badRequest('Email is required');
  if (!ADMIN_TYPES.includes(adminType)) {
    throw ApiError.badRequest(`adminType must be one of ${ADMIN_TYPES.join(', ')}`);
  }
  if (adminType === 'super' || tenantScope) await assertMayChangePrivileges({ by });

  const existing = await adminRepository.findByEmail(normalizedEmail);
  if (existing) {
    throw ApiError.conflict(
      existing.status === 'pending'
        ? 'This admin has already been invited; resend the invitation instead'
        : 'An admin with this email already exists',
    );
  }

  let admin;
  try {
    admin = await adminRepository.create({
      email: normalizedEmail,
      passwordHash: null,
      adminType,
      status: 'pending',
      tenantScope: tenantScope || null,
      profile: { name: name ?? '' },
      createdBy: by,
    });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('An admin with this email already exists');
    throw err;
  }
  const { invitation, delivered } = await adminInvitationService.issue({ admin, by });
  return { admin: stripSecrets(admin), invitation, delivered };
}

/** Resend a pending admin invitation (new link; cooldown enforced). */
export function resendInvitation({ id, by = null } = {}) {
  return adminInvitationService.resend({ adminId: id, by });
}

/** Revoke a pending admin invitation (removes the never-activated admin). */
export function revokeInvitation({ id, by = null, reason = null } = {}) {
  return adminInvitationService.revoke({ adminId: id, by, reason });
}

/** Invitation history (paged, optional status filter). */
export function listInvitations(opts = {}) {
  return adminInvitationService.list(opts);
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

  // Only supers manage supers (403); then last-super protection (409), then
  // the privilege-change guard (403).
  await assertMayManageAdmin({ by, target: admin });
  await assertNotLastActiveSuper({
    targetId: id,
    desiredAdminType: set.adminType,
    actorId: by,
  });
  if (set.adminType !== undefined || set.tenantScope !== undefined) {
    await assertMayChangePrivileges({ by, targetId: id });
  }
  if (set.tenantScope) await assertScopeTenantExists({ tenantScope: set.tenantScope, by });

  const demotesSuper = set.adminType !== undefined && set.adminType !== 'super'
    && admin.adminType === 'super' && admin.status === 'active';
  const updated = demotesSuper
    ? await changeSuperSafely({ target: admin, set, by })
    : await adminRepository.update(id, set, { by });

  // Lowering the type revokes built-in roles above the new ceiling.
  if (set.adminType !== undefined && ADMIN_TYPE_RANK[set.adminType] < ADMIN_TYPE_RANK[admin.adminType]) {
    await revokeRolesAboveType({ adminId: id, adminType: set.adminType });
  }
  await invalidateScope(admin.tenantScope ?? null);
  if (set.tenantScope !== undefined && set.tenantScope) await invalidateScope(set.tenantScope);
  await invalidateScope(null);
  const changes = {};
  if (set.adminType !== undefined && set.adminType !== admin.adminType) {
    changes.adminType = { from: admin.adminType ?? null, to: set.adminType };
  }
  if (set.tenantScope !== undefined && (set.tenantScope ?? null) !== (admin.tenantScope ?? null)) {
    changes.tenantScope = { from: admin.tenantScope ?? null, to: set.tenantScope ?? null };
  }
  if (Object.keys(changes).length > 0) {
    await securityEvent('ADMIN_PRIVILEGE_CHANGED', {
      tenantId: null,
      resource: { type: 'admin', id: String(id) },
      metadata: { operation: 'update', adminId: String(id), changes },
    });
  }
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
  await assertMayManageAdmin({ by, target: admin });
  await assertNotLastActiveSuper({
    targetId: id,
    desiredStatus: 'suspended',
    actorId: by,
  });
  if (admin.status !== 'suspended') {
    if (admin.adminType === 'super' && admin.status === 'active') {
      await changeSuperSafely({ target: admin, set: { status: 'suspended' }, by });
    } else {
      await adminRepository.suspend(id, by);
    }
    // Side effects only after the last-super check has passed.
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
  await assertMayManageAdmin({ by, target: admin });
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
  await assertMayChangePrivileges({ by, targetId: adminId });
  assertGrantable({ admin, role, tenantId });

  if (expiresAt) {
    const deadline = new Date(expiresAt);
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
      throw ApiError.badRequest('expiresAt must be a future date');
    }
  }

  const grant = await adminRepository.assignRole(adminId, roleId, { by, tenantId, expiresAt });
  await invalidateScope(tenantId ?? null);
  if (tenantId) await invalidateScope(null);
  if (!grant) return { alreadyAssigned: true };
  await securityEvent('ROLE_GRANTED', {
    tenantId: tenantId ?? null,
    resource: { type: 'admin', id: String(adminId) },
    metadata: {
      granteeType: 'admin',
      granteeId: String(adminId),
      roleId: String(roleId),
      roleName: role.name,
      scopeTenantId: tenantId ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
  });
  return grant;
}

/**
 * Revoke a role grant from an admin. Idempotent: a missing grant resolves
 * to success with `removed: 0`.
 *
 * @param {Object} opts
 * @param {string} opts.adminId
 * @param {string} opts.roleId
 * @param {string|null} [opts.tenantId=null] - the grant's tenant scope; pass it to
 *   revoke a tenant-scoped support grant.
 * @param {string|null} [opts.by=null] - acting admin id.
 * @returns {Promise<{ removed: number }>}
 */
export async function revokeRole({ adminId, roleId, tenantId = null, by = null } = {}) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  const role = await roleRepository.findById(roleId);
  if (!role) throw ApiError.notFound('Role not found');
  await assertMayChangePrivileges({ by, targetId: adminId });

  // Last-super protection extends to revoking the super-admin role grant.
  const guardsSuperRole = !tenantId && admin.adminType === 'super' && admin.status === 'active'
    && isSuperAdminRole(role);
  let revokedGrant = null;
  if (guardsSuperRole) {
    const superRoleIds = await superAdminRoleIds();
    const grants = (await adminRepository.listGrantsForAdmin(adminId)).filter((g) => g.tenantId === null);
    revokedGrant = grants.find((g) => String(g.roleId) === String(roleId)) ?? null;
    const holdsThis = Boolean(revokedGrant);
    const holdsOther = grants.some((g) => String(g.roleId) !== String(roleId) && superRoleIds.includes(String(g.roleId)));
    // Fast path; the post-write check below covers concurrent revocations.
    if (holdsThis && !holdsOther && await adminRepository.countActiveSupersHoldingRoles(superRoleIds) <= 1) {
      throw lastSuperError('Refusing to revoke the last super administrator role grant');
    }
  }

  const removed = await adminRepository.revokeRole(adminId, roleId, { tenantId });
  if (guardsSuperRole && removed > 0) {
    const superRoleIds = await superAdminRoleIds();
    if (await adminRepository.countActiveSupersHoldingRoles(superRoleIds) < 1) {
      // Compensate: put the grant back exactly as it was (same grantor and
      // expiry, so a temporary grant never becomes permanent), then refuse.
      await adminRepository.assignRole(adminId, roleId, {
        by: revokedGrant?.grantedBy ?? by,
        tenantId: null,
        expiresAt: revokedGrant?.expiresAt ?? null,
      });
      await invalidateScope(null);
      throw lastSuperError('Refusing to revoke the last super administrator role grant');
    }
  }
  await invalidateScope(tenantId ?? null);
  if (tenantId) await invalidateScope(null);
  if (removed > 0) {
    await securityEvent('ROLE_REVOKED', {
      tenantId: tenantId ?? null,
      resource: { type: 'admin', id: String(adminId) },
      metadata: {
        granteeType: 'admin',
        granteeId: String(adminId),
        roleId: String(roleId),
        roleName: role.name,
        scopeTenantId: tenantId ?? null,
      },
    });
  }
  return { removed };
}

/* ------------------------------ internals -------------------------------- */

/**
 * Guard for privilege-changing operations (role grants, adminType and
 * tenantScope changes, creating super admins):
 *   - an admin may never change their own privileges;
 *   - only an active `super` admin may change anyone's privileges.
 * `by` is the acting admin id (null for internal/system calls, which are
 * trusted: bootstrap, migrations, tests seeding fixtures).
 */
export async function assertMayChangePrivileges({ by, targetId = null }) {
  // Requests always attribute the acting admin by ObjectId (req.admin.id);
  // null or a non-ObjectId label means an internal/system caller.
  if (!by || !/^[0-9a-fA-F]{24}$/.test(String(by))) return;
  if (targetId && String(by) === String(targetId)) {
    throw await privilegeDenied({ by, targetId, reason: 'self_change', message: 'You cannot change your own roles, type or scope' });
  }
  const actorDoc = await adminRepository.findById(by);
  if (!actorDoc || actorDoc.status !== 'active' || actorDoc.adminType !== 'super') {
    throw await privilegeDenied({ by, targetId, reason: 'not_active_super', message: 'Only an active super administrator can change administrator privileges' });
  }
}

/** Record a refused privilege change as a security event and build the 403. */
async function privilegeDenied({ by, targetId = null, reason, message }) {
  await securityEvent('ADMIN_PRIVILEGE_CHANGE_DENIED', {
    actor: { type: 'admin', id: String(by) },
    tenantId: null,
    resource: targetId ? { type: 'admin', id: String(targetId) } : undefined,
    reason,
    metadata: { reason, targetId: targetId ? String(targetId) : null },
  });
  return ApiError.forbidden(message);
}

/** Whether `by` names a request actor (an admin ObjectId) rather than the system. */
function isRequestActor(by) {
  return Boolean(by) && /^[0-9a-fA-F]{24}$/.test(String(by));
}

/**
 * Only an active super admin may manage a super admin (profile, suspend,
 * restore): "platform cannot manage super admins".
 */
async function assertMayManageAdmin({ by, target }) {
  if (!isRequestActor(by) || target?.adminType !== 'super') return;
  if (String(by) === String(target._id)) return;
  const actorDoc = await adminRepository.findById(by);
  if (!actorDoc || actorDoc.status !== 'active' || actorDoc.adminType !== 'super') {
    throw await privilegeDenied({ by, targetId: target._id, reason: 'manage_super_requires_super', message: 'Only an active super administrator can manage a super administrator' });
  }
}

/**
 * A request may only scope an admin to a tenant that exists. System callers
 * (bootstrap, migrations, fixtures) are trusted.
 */
async function assertScopeTenantExists({ tenantScope, by }) {
  if (!isRequestActor(by)) return;
  const tenant = mongoose.isValidObjectId(String(tenantScope))
    ? await tenantRepository.findById(String(tenantScope))
    : null;
  if (!tenant) throw ApiError.badRequest('tenantScope must reference an existing tenant');
}

function typedError(err, code) {
  err.code = code;
  return err;
}

function lastSuperError(message) {
  return typedError(ApiError.conflict(message), ERROR_CODES.LAST_SUPER_ADMIN);
}

/**
 * Role-grant rules: platform roles only; no legacy all-permission roles;
 * built-in roles within the admin's type ceiling; tenant-scoped grants only
 * for an admin confined to that tenant.
 */
function assertGrantable({ admin, role, tenantId }) {
  if (role.tenantId !== null && role.tenantId !== undefined) {
    throw ApiError.badRequest('Only platform roles can be granted to administrators');
  }
  if (LEGACY_PLATFORM_ROLE_NAMES.includes(role.name) && role.isSystem && !findPlatformRole(role.name)) {
    throw ApiError.conflict('Legacy bootstrap roles can no longer be granted; grant a built-in platform role instead');
  }
  if (isBuiltInPlatformRole(role)) {
    const definition = findPlatformRole(role.name);
    if (ADMIN_TYPE_RANK[definition.adminType] > (ADMIN_TYPE_RANK[admin.adminType] ?? 0)) {
      throw typedError(
        ApiError.conflict(`The ${definition.label} role exceeds this administrator's type (${admin.adminType}); change the type first`),
        ERROR_CODES.ROLE_ABOVE_ADMIN_TYPE,
      );
    }
  }
  if (tenantId && String(tenantId) !== String(admin.tenantScope ?? '')) {
    throw ApiError.badRequest('A tenant-scoped grant requires the administrator to be scoped to that tenant (tenantScope)');
  }
}

/** Revoke every built-in platform role grant above `adminType`'s ceiling. */
async function revokeRolesAboveType({ adminId, adminType }) {
  const grants = await adminRepository.listGrantsForAdmin(adminId);
  for (const grant of grants) {
    const role = await roleRepository.findById(grant.roleId);
    if (!isBuiltInPlatformRole(role)) continue;
    const definition = findPlatformRole(role.name);
    if (ADMIN_TYPE_RANK[definition.adminType] > ADMIN_TYPE_RANK[adminType]) {
      const removed = await adminRepository.revokeRole(adminId, grant.roleId, { tenantId: grant.tenantId ?? null });
      await invalidateScope(grant.tenantId ?? null);
      if (removed > 0) {
        await securityEvent('ROLE_REVOKED', {
          tenantId: grant.tenantId ?? null,
          resource: { type: 'admin', id: String(adminId) },
          reason: 'admin_type_lowered',
          metadata: { granteeType: 'admin', granteeId: String(adminId), roleId: String(grant.roleId), roleName: role.name, scopeTenantId: grant.tenantId ?? null, automatic: true },
        });
      }
    }
  }
}

/** Whether a role is a super-admin role (built-in super_admin or legacy `super`). */
function isSuperAdminRole(role) {
  if (!role || (role.tenantId !== null && role.tenantId !== undefined)) return false;
  return role.name === PLATFORM_ROLE_NAMES.SUPER || (role.name === 'super' && Boolean(role.isSystem));
}

/** Ids of the platform roles that make an admin a working super admin. */
async function superAdminRoleIds() {
  const ids = [];
  for (const name of [PLATFORM_ROLE_NAMES.SUPER, 'super']) {
    const role = await roleRepository.findByName({ tenantId: null, name });
    if (role && isSuperAdminRole(role)) ids.push(String(role._id));
  }
  return ids;
}

function readPath(doc, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

/**
 * Apply `set` to an active super admin (demotion or suspension) while
 * guaranteeing at least one active super admin remains, without a
 * transaction:
 *   1. compare-and-set the target only while it is still an active super;
 *   2. re-count active supers AFTER the write;
 *   3. if none remain, undo the write (compensation) and refuse 409.
 * Two concurrent demotions of the last two supers therefore cannot both
 * succeed: whichever counts last sees the other's write. Side effects
 * (session revocation, role clean-up) run only after this returns.
 */
async function changeSuperSafely({ target, set, by }) {
  const expected = { adminType: 'super', status: 'active' };
  const updated = await adminRepository.updateIfMatch(target._id, expected, set, { by });
  if (!updated) {
    throw ApiError.conflict('The administrator changed concurrently; reload and retry');
  }
  const remaining = await adminRepository.countActiveSupers();
  if (remaining < 1) {
    const undo = {};
    for (const key of Object.keys(set)) undo[key] = readPath(target, key) ?? null;
    const written = {};
    if (set.adminType !== undefined) written.adminType = set.adminType;
    if (set.status !== undefined) written.status = set.status;
    await adminRepository.updateIfMatch(target._id, written, undo, { by: target.updatedBy ?? null });
    throw lastSuperError('Refusing to lock out the last active super administrator');
  }
  return updated;
}

/**
 * Strip secrets (passwordHash, mfaSecret, recovery-code digests) from a lean
 * admin document.
 */
export function stripSecrets(admin) {
  if (!admin) return admin;
  const { passwordHash, mfaSecret, mfaRecoveryCodes, ...safe } = admin;
  return safe;
}

/**
 * Count currently-active super admins in the system. Used to enforce the
 * "last active super admin" rule against accidental lockout.
 *
 * @returns {Promise<number>}
 */
export async function countActiveSupers() {
  return adminRepository.countActiveSupers();
}

/**
 * Throw if a pending mutation would leave the platform with zero active
 * super admins. Centralised so suspend, restore, and adminType updates all
 * share the same rule.
 *
 * @param {Object} opts
 * @param {string} opts.targetId - the admin being mutated.
 * @param {string} [opts.desiredAdminType] - new adminType if updating.
 * @param {string} [opts.desiredStatus] - new status if changing status.
 * @param {string} [opts.actorId] - the admin performing the mutation.
 */
export async function assertNotLastActiveSuper({
  targetId,
  desiredAdminType,
  desiredStatus,
  actorId = null,
} = {}) {
  const target = await adminRepository.findById(targetId);
  if (!target) throw ApiError.notFound('Admin not found');
  const willRemainActive =
    (desiredStatus ?? target.status) !== 'suspended' &&
    (desiredStatus ?? target.status) !== 'locked' &&
    (desiredStatus ?? target.status) !== 'pending';
  const willStillBeSuper = (desiredAdminType ?? target.adminType) === 'super';
  if (!willRemainActive || !willStillBeSuper) {
    if (target.adminType !== 'super' || target.status !== 'active') return;
    const count = await adminRepository.countActiveSupers();
    if (count <= 1) {
      throw lastSuperError('Refusing to lock out the last active super administrator');
    }
  }
  if (actorId && String(actorId) === String(targetId)) {
    if (target.adminType === 'super' && target.status === 'active') {
      const count = await adminRepository.countActiveSupers();
      if (count <= 1) {
        throw lastSuperError('Refusing to demote the last active super administrator');
      }
    }
  }
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
  invite,
  resendInvitation,
  revokeInvitation,
  listInvitations,
  _meta: { portal: 'admin', stripSecrets: true, invalidatesCache: 'iam:rbac:<scope>' },
};
