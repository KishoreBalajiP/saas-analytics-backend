/**
 * Tenant Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   The orchestration layer for the tenant admin API. Composes the
 *   repositories and the dedicated tenant services (initialization,
 *   lifecycle, statistics, settings) behind a single stable surface.
 *
 * RESPONSIBILITY
 *   - create / list / getById / update          (tenant profile CRUD)
 *   - statistics / members / billing            (tenant read surfaces)
 *   - initialize                                (onboarding)
 *   - changeOwner                               (owner reassignment)
 *
 * CODING GUIDELINES
 *   - Status transitions NEVER happen through `update`; they go through
 *     the lifecycle service (this keeps the status graph enforceable in
 *     one place).
 *   - `slug` is immutable once set: `create` derives it from `name`, and
 *     `update` ignores it.
 *   - Audit events use module `iam.tenants` and the platform-admin actor
 *     resolved by the controller.
 */

import { shortToken } from '../utils/id.js';
import ApiError from '../utils/ApiError.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import { emit as auditEmit } from './auditLog.service.js';
import * as tenantInitialization from './tenantInitialization.service.js';
import * as tenantLifecycle from './tenantLifecycle.service.js';
import { getStatistics } from './tenantStatistics.service.js';
import * as tenantSettings from './tenantSettings.service.js';

/** Profile fields a caller may update on a tenant. Status/slug are excluded. */
const UPDATABLE_FIELDS = [
  'name', 'logoUrl', 'planId', 'billingEmail', 'country',
  'defaultLocale', 'defaultTimezone', 'defaultCurrency', 'trialEndsAt',
];

function actorOf(by) {
  return by ? { type: 'admin', id: by } : { type: 'system', id: 'system' };
}

function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash, failedAttempts, lockedUntil, ...safe } = user;
  return safe;
}

/** Derive a URL-safe slug from a name and guarantee uniqueness. */
async function uniqueSlug(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!base) throw ApiError.badRequest('A valid tenant name is required to derive a slug');
  let slug = base;
  let existing = await tenantRepository.findBySlug(slug);
  let attempt = 0;
  while (existing && attempt < 5) {
    slug = `${base}-${shortToken(4).toLowerCase()}`;
    existing = await tenantRepository.findBySlug(slug);
    attempt += 1;
  }
  if (existing) throw ApiError.conflict('Could not allocate a unique tenant slug');
  return slug;
}

/**
 * Create a tenant. When `initialize` is true, runs the full onboarding
 * sequence (owner, roles, permissions, settings, flags) in the same call.
 *
 * @param {Object} opts
 * @param {Object} opts.tenant - `{ name, planId?, billingEmail?, country?, ... }`.
 * @param {Object} [opts.owner] - `{ email?, name?, password? }`.
 * @param {boolean} [opts.initialize=false]
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ tenant: Object, owner: Object|null, alreadyInitialized?: boolean }>}
 */
export async function create({ tenant = {}, owner = {}, initialize = false, by = null } = {}) {
  if (!tenant.name || !String(tenant.name).trim()) {
    throw ApiError.badRequest('Tenant name is required');
  }
  const slug = await uniqueSlug(tenant.name);
  const created = await tenantRepository.create({
    name: String(tenant.name).trim(),
    slug,
    logoUrl: tenant.logoUrl ?? null,
    planId: tenant.planId ?? null,
    status: 'pending',
    billingEmail: tenant.billingEmail ?? null,
    country: tenant.country ?? null,
    defaultLocale: tenant.defaultLocale ?? 'en',
    defaultTimezone: tenant.defaultTimezone ?? 'UTC',
    defaultCurrency: tenant.defaultCurrency ?? 'USD',
    trialEndsAt: tenant.trialEndsAt ?? null,
    createdBy: by,
  });

  await auditEmit({
    actor: actorOf(by),
    action: 'tenant.created',
    module: 'iam.tenants',
    resource: { type: 'tenant', id: created._id },
    tenantId: created._id,
    after: { name: created.name, slug: created.slug, status: created.status },
  });

  if (initialize) {
    return tenantInitialization.initialize({ tenantId: created._id, owner, by });
  }
  return { tenant: created };
}

/** Paginated tenant list (platform admin surface). */
export async function list({ filter = {}, page = 1, limit = 20 } = {}) {
  return tenantRepository.list({ filter, page, limit });
}

/** Get a single tenant by id. */
export async function getById({ id } = {}) {
  const tenant = await tenantRepository.findById(id);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return tenant;
}

/** Update tenant profile fields. Status/lifecycle changes are rejected. */
export async function update({ id, patch = {}, by = null } = {}) {
  const tenant = await tenantRepository.findById(id);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const set = {};
  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] !== undefined) set[field] = patch[field];
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');
  if (set.status !== undefined || set.slug !== undefined || set.ownerId !== undefined) {
    throw ApiError.badRequest('Use the lifecycle endpoints to change tenant status, owner, or slug');
  }
  set.updatedBy = by;

  const updated = await tenantRepository.update(id, set);
  await auditEmit({
    actor: actorOf(by),
    action: 'tenant.updated',
    module: 'iam.tenants',
    resource: { type: 'tenant', id },
    tenantId: id,
    before: Object.fromEntries(Object.keys(set).map((k) => [k, tenant[k]])),
    after: Object.fromEntries(Object.keys(set).map((k) => [k, updated[k]])),
  });
  return updated;
}

/** Lifecycle facade: delegate to the lifecycle service. */
export const lifecycle = {
  suspend: tenantLifecycle.suspend,
  restore: tenantLifecycle.restore,
  disable: tenantLifecycle.disable,
  archive: tenantLifecycle.archive,
};

/** Run (or safely re-run) onboarding for a tenant. */
export const initialize = ({ tenantId, owner = {}, by = null } = {}) =>
  tenantInitialization.initialize({ tenantId, owner, by });

/** Per-tenant activity statistics. */
export const statistics = ({ tenantId } = {}) => getStatistics({ tenantId });

/** Tenant settings group surface (effective + overrides). */
export const settings = {
  listGroups: tenantSettings.listGroups,
  getGroup: tenantSettings.getGroup,
  updateGroup: tenantSettings.updateGroup,
};

/**
 * Tenant members: paginated users with their role names attached.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated members (secrets stripped).
 */
export async function members({ tenantId, search, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const filter = {};
  if (search) filter['profile.name'] = { $regex: escapeRegExp(search), $options: 'i' };
  const result = await userRepository.list({ tenantId, filter, page, limit });
  const roles = await roleRepository.resolveRolesForUsers({
    tenantId,
    userIds: result.docs.map((u) => String(u._id)),
  });
  return {
    ...result,
    docs: result.docs.map((user) => ({
      ...stripSecrets(user),
      roles: roles.get(String(user._id)) ?? [],
    })),
  };
}

/**
 * Billing surface for a tenant. Billing is a later-phase deliverable;
 * this returns the facts the tenant already records today.
 */
export async function billing({ tenantId } = {}) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return {
    tenantId,
    planId: tenant.planId,
    status: tenant.status,
    billingEmail: tenant.billingEmail,
    defaultCurrency: tenant.defaultCurrency,
    trialEndsAt: tenant.trialEndsAt,
    hasHistory: false,
  };
}

/** Reassign the tenant owner. The user must already exist in the tenant. */
export async function changeOwner({ tenantId, userId, by = null } = {}) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  const user = await userRepository.findById(userId);
  if (!user || String(user.tenantId) !== String(tenantId)) {
    throw ApiError.notFound('User not found in this tenant');
  }
  const updated = await tenantRepository.update(tenantId, { ownerId: String(userId), updatedBy: by });
  await auditEmit({
    actor: actorOf(by),
    action: 'tenant.owner_changed',
    module: 'iam.tenants',
    resource: { type: 'tenant', id: tenantId },
    tenantId,
    before: { ownerId: tenant.ownerId },
    after: { ownerId: updated.ownerId },
  });
  return updated;
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  create,
  list,
  getById,
  update,
  lifecycle,
  initialize,
  statistics,
  settings,
  members,
  billing,
  changeOwner,
  _meta: { module: 'iam.tenants', lifecycleVia: 'services/tenantLifecycle.service.js' },
};
