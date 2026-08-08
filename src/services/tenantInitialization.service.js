/**
 * Tenant Initialization Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   The idempotent onboarding sequence that turns a `pending` tenant into
 *   a fully-provisioned `active` tenant:
 *
 *     1. seed platform modules        (18-module contract + IAM children)
 *     2. seed tenant-scoped permissions (module.action keys)
 *     3. seed platform settings        (tenantSettings.initialize)
 *     4. seed feature flags            (featureFlagService.ensureDefaults)
 *     5. create default roles          (Owner / Admin / Manager / Viewer)
 *     6. attach permissions to roles
 *     7. create/reuse the owner user   (and assign the Owner role)
 *     8. mark the tenant `ready` + `active`
 *
 * IDEMPOTENCY
 *   Every step is re-runnable: module/permission creation is skip-on-
 *   duplicate, role creation is find-or-create, user creation is reuse-on-
 *   existing-email. A second `initialize` on a `ready` tenant is a no-op.
 *
 * CODING GUIDELINES
 *   - The owner user is created tenant-scoped with the platform-provided
 *     password when supplied; without one the user is `invited` so the
 *     invite flow sets their credentials.
 *   - All writes are audited via `auditLogService.emit` (module
 *     `iam.tenants`); the model-level audit plugin events are wired to the
 *     persistent trail in a later sprint.
 */

import ApiError from '../utils/ApiError.js';
import { hash } from '../utils/password.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { UserRole } from '../models/UserRole.js';
import { BUILTIN_MODULES, IAM_MODULES } from '../models/Module.js';
import * as tenantSettings from './tenantSettings.service.js';
import * as featureFlagService from './featureFlag.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { invalidateScope } from './rbac.cache.service.js';

/** Tenant-relevant modules and the actions their permissions expose. */
const TENANT_PERMISSION_ACTIONS = Object.freeze({
  users: ['view', 'create', 'update', 'delete'],
  roles: ['view', 'create', 'update', 'delete', 'assign'],
  settings: ['view', 'configure'],
  feature_flags: ['view', 'configure'],
  analytics: ['view', 'create', 'update', 'delete', 'export'],
  connectors: ['view', 'create', 'update', 'delete', 'configure'],
  dashboards: ['view', 'create', 'update', 'delete'],
  reports: ['view', 'create', 'update', 'delete', 'export'],
  notifications: ['view', 'configure'],
  master_data: ['view'],
  email_templates: ['view', 'create', 'update', 'delete'],
});

const P = (module, actions) => actions.map((action) => `${module}.${action}`);

/** Default roles created in every tenant on onboarding. */
const DEFAULT_ROLES = Object.freeze({
  Owner: {
    description: 'Full control of the tenant',
    isSystem: true,
    permissions: [
      ...P('users', ['view', 'create', 'update', 'delete']),
      ...P('roles', ['view', 'create', 'update', 'delete', 'assign']),
      ...P('settings', ['view', 'configure']),
      ...P('feature_flags', ['view', 'configure']),
      ...P('analytics', ['view', 'create', 'update', 'delete', 'export']),
      ...P('connectors', ['view', 'create', 'update', 'delete', 'configure']),
      ...P('dashboards', ['view', 'create', 'update', 'delete']),
      ...P('reports', ['view', 'create', 'update', 'delete', 'export']),
      ...P('notifications', ['view', 'configure']),
      ...P('master_data', ['view']),
      ...P('email_templates', ['view', 'create', 'update', 'delete']),
    ],
  },
  Admin: {
    description: 'Manages the tenant day to day',
    isSystem: false,
    permissions: [
      ...P('users', ['view', 'create', 'update']),
      ...P('roles', ['view']),
      ...P('settings', ['view', 'configure']),
      ...P('feature_flags', ['view', 'configure']),
      ...P('analytics', ['view', 'create', 'update', 'export']),
      ...P('connectors', ['view', 'create', 'update', 'configure']),
      ...P('dashboards', ['view', 'create', 'update']),
      ...P('reports', ['view', 'create', 'update', 'export']),
      ...P('notifications', ['view', 'configure']),
      ...P('master_data', ['view']),
      ...P('email_templates', ['view', 'create', 'update']),
    ],
  },
  Manager: {
    description: 'Builds and maintains analytics content',
    isSystem: false,
    permissions: [
      ...P('users', ['view']),
      ...P('analytics', ['view', 'create', 'update']),
      ...P('connectors', ['view']),
      ...P('dashboards', ['view', 'create', 'update']),
      ...P('reports', ['view', 'create', 'update']),
      ...P('notifications', ['view']),
      ...P('master_data', ['view']),
    ],
  },
  Viewer: {
    description: 'Read-only access',
    isSystem: false,
    permissions: [
      ...P('users', ['view']),
      ...P('analytics', ['view']),
      ...P('connectors', ['view']),
      ...P('dashboards', ['view']),
      ...P('reports', ['view']),
      ...P('notifications', ['view']),
      ...P('master_data', ['view']),
    ],
  },
});

function systemActor(by) {
  return by ? { type: 'admin', id: by } : { type: 'system', id: 'system' };
}

/** Find a module or create it (idempotent). Returns the module (plain). */
async function ensureModule(key, { name, by }) {
  const existing = await permissionRepository.findModuleByKey(key);
  if (existing) return existing;
  return permissionRepository.createModule({
    key,
    name,
    description: '',
    isSystem: true,
    createdBy: by,
  });
}

/** Ensure every built-in module exists (top-level first, then children). */
async function ensureModules({ by }) {
  for (const key of BUILTIN_MODULES) {
    await ensureModule(key, { name: titleCase(key), by });
  }
  for (const key of IAM_MODULES) {
    await ensureModule(key, { name: `IAM ${titleCase(key.split('.')[1])}`, by });
  }
}

/** Ensure the tenant-scoped permission keys exist (idempotent). */
async function ensurePermissions({ by }) {
  for (const [moduleKey, actions] of Object.entries(TENANT_PERMISSION_ACTIONS)) {
    const module = await permissionRepository.findModuleByKey(moduleKey);
    if (!module) continue;
    for (const action of actions) {
      await permissionRepository.registerAction({
        moduleId: module._id,
        module: moduleKey,
        action,
        description: `${titleCase(action)} ${moduleKey}`,
        isSystem: true,
        createdBy: by,
      });
    }
  }
}

/** Find a tenant-scoped role or create it (idempotent). Returns the role. */
async function ensureRole({ tenantId, name, description, isSystem, by }) {
  const existing = await roleRepository.findByName({ tenantId, name });
  if (existing) return existing;
  return roleRepository.create({
    tenantId,
    name,
    description,
    level: 'tenant',
    isSystem,
    createdBy: by,
  });
}

/** Create/reuse the owner user and grant the Owner role. */
async function createOwner({ tenantId, owner = {}, by }) {
  if (!owner.email) return null;
  const email = String(owner.email).trim().toLowerCase();
  let user = await userRepository.findByEmail(tenantId, email);
  if (!user) {
    const passwordHash = owner.password ? await hash(owner.password) : null;
    const status = owner.password ? 'active' : 'invited';
    user = await userRepository.create({
      tenantId,
      email,
      passwordHash,
      status,
      profile: { name: owner.name ?? '', locale: 'en', timezone: 'UTC' },
      invitedBy: owner.password ? null : by,
      acceptedAt: owner.password ? new Date() : null,
    });
  }
  return user;
}

/** Assign a role to a user, skipping when the grant already exists. */
async function assignRole({ tenantId, userId, roleId, by }) {
  try {
    const row = new UserRole({ tenantId, userId, roleId, grantedBy: by, grantedAt: new Date() });
    await row.save();
    return row.toObject();
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/**
 * Run (or re-run, safely) the onboarding sequence for a tenant.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {{ email?: string, name?: string, password?: string }} [opts.owner]
 * @param {string|null} [opts.by=null] - platform-admin actor id.
 * @returns {Promise<{ tenant: Object, owner: Object|null, alreadyInitialized: boolean }>}
 */
export async function initialize({ tenantId, owner = {}, by = null } = {}) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (tenant.onboardingStatus === 'ready' && tenant.status === 'active') {
    return { tenant, owner: tenant.ownerId ? { _id: tenant.ownerId } : null, alreadyInitialized: true };
  }

  const actor = systemActor(by);

  await ensureModules({ by });
  await ensurePermissions({ by });
  await tenantSettings.initialize({ by: by ?? 'system' });
  await featureFlagService.ensureDefaults({ by: by ?? 'system' });

  const ownerUser = await createOwner({ tenantId, owner, by });

  for (const [name, def] of Object.entries(DEFAULT_ROLES)) {
    const role = await ensureRole({
      tenantId,
      name,
      description: def.description,
      isSystem: def.isSystem,
      by,
    });
    for (const permissionKey of def.permissions) {
      const permission = await permissionRepository.findPermissionByKey(permissionKey);
      if (permission) await roleRepository.attachPermission(role._id, permission._id, by);
    }
    if (ownerUser && name === 'Owner') {
      await assignRole({ tenantId, userId: ownerUser._id, roleId: role._id, by });
    }
  }

  const updated = await tenantRepository.update(tenantId, {
    onboardingStatus: 'ready',
    status: 'active',
    ownerId: ownerUser?._id ?? tenant.ownerId ?? null,
    updatedBy: by,
  });

  await invalidateScope(tenantId);

  await auditEmit({
    actor,
    action: 'tenant.initialized',
    module: 'iam.tenants',
    resource: { type: 'tenant', id: tenantId },
    tenantId,
    before: { status: tenant.status, onboardingStatus: tenant.onboardingStatus },
    after: { status: updated.status, onboardingStatus: updated.onboardingStatus, ownerId: updated.ownerId },
    reason: 'Tenant onboarding completed',
  });

  return { tenant: updated, owner: ownerUser, alreadyInitialized: false };
}

/** Human-friendly module display name. */
function titleCase(value) {
  return String(value).replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default {
  initialize,
  DEFAULT_ROLES,
  TENANT_PERMISSION_ACTIONS,
  _meta: { idempotent: true, module: 'iam.tenants' },
};
