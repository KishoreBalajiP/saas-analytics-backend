/**
 * Tenant Initialization Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   The idempotent onboarding sequence that turns a `pending` tenant into
 *   a fully-provisioned `active` tenant:
 *
 *     1. seed platform modules        (19-module contract + IAM children)
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
// members: tenant-only workspace module (roadmap 2.10).
import { MEMBERS_MODULES } from '../models/Module.js';
import * as tenantSettings from './tenantSettings.service.js';
import * as featureFlagService from './featureFlag.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import usageService from './usage.service.js';
// billing: every initialised workspace gets its subscription (free plan, or
// a trial when the tenant's plan defines trialDays).
import subscriptionService from './subscription.service.js';
import logger from '../utils/logger.js';

/** Tenant-relevant modules and the actions their permissions expose. */
const TENANT_PERMISSION_ACTIONS = Object.freeze({
  users: ['view', 'create', 'update', 'delete'],
  roles: ['view', 'create', 'update', 'delete', 'assign'],
  settings: ['view', 'configure', 'update', 'delete'],
  feature_flags: ['view', 'configure', 'update', 'delete'],
  analytics: ['view', 'create', 'update', 'delete', 'export'],
  connectors: ['view', 'create', 'update', 'delete', 'configure', 'preview', 'sync'],
  // vizbuilder: 'assign' = manage sharing on every dashboard.
  dashboards: ['view', 'create', 'update', 'delete', 'assign'],
  reports: ['view', 'create', 'update', 'delete', 'export'],
  notifications: ['view', 'configure', 'update', 'delete'],
  alerts: ['view', 'create', 'update', 'delete', 'evaluate'],
  master_data: ['view'],
  email_templates: ['view', 'create', 'update', 'delete'],
  // External-API credentials + public embed surface (Sprint 9).
  api_keys: ['view', 'create', 'update', 'delete'],
  embed: ['view', 'create', 'delete'],
  // Workspace billing self-service (subscription.routes.js).
  'iam.subscriptions': ['view', 'update'],
  'iam.entitlements': ['view'],
  // ai-catalogue: metric definitions (manage = create/edit/archive drafts; approve = publish a version).
  metrics: ['view', 'manage', 'approve'],
  // mfa-tenant: workspace security policy (MFA required) and
  // Owner-assisted member MFA reset (`/workspace/security`).
  security: ['view', 'configure'],
  // rls: dataset grants, row rules, user attributes (`/data-access`).
  data_access: ['view', 'configure'],
  // members: Owner-only workspace powers (roadmap 2.10): transfer ownership
  // and delete the workspace. Never assignable to custom roles.
  workspace: ['transfer', 'delete'],
  // backups: workspace data export (roadmap 2.9). `view` lists exports,
  // `export` requests one and downloads the archive.
  data_exports: ['view', 'export'],
});

/**
 * Platform/governance modules and their canonical permission actions. These
 * permission rows are registered alongside the tenant catalogue so a
 * platform super-admin role can grant `monitoring.view`, `support.impersonate`
 * etc. to support staff. The default tenant roles deliberately do NOT
 * reference them - governance surfaces stay platform-admin-only.
 */
const PLATFORM_PERMISSION_ACTIONS = Object.freeze({
  monitoring: ['view'],
  support: ['impersonate', 'recover', 'broadcast', 'lookup'],
  audit_logs: ['view', 'export'],
  access_logs: ['view', 'export'],
  compliance: ['view', 'configure', 'file', 'cancel'],
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
      ...P('settings', ['view', 'configure', 'update', 'delete']),
      ...P('feature_flags', ['view', 'configure', 'update', 'delete']),
      ...P('analytics', ['view', 'create', 'update', 'delete', 'export']),
      ...P('connectors', ['view', 'create', 'update', 'delete', 'configure', 'preview', 'sync']),
      ...P('dashboards', ['view', 'create', 'update', 'delete']),
      // vizbuilder:
      ...P('dashboards', ['assign']),
      ...P('reports', ['view', 'create', 'update', 'delete', 'export']),
      ...P('notifications', ['view', 'configure', 'update', 'delete']),
      ...P('master_data', ['view']),
      ...P('email_templates', ['view', 'create', 'update', 'delete']),
      ...P('alerts', ['view', 'create', 'update', 'delete', 'evaluate']),
      ...P('api_keys', ['view', 'create', 'update', 'delete']),
      ...P('embed', ['view', 'create', 'delete']),
      // Billing: view plans/usage and pay. Plan changes to paid plans only
      // happen through checkout + payment verification.
      ...P('iam.subscriptions', ['view', 'update']),
      ...P('iam.entitlements', ['view']),
      // ai-catalogue: metric definitions.
      ...P('metrics', ['view', 'manage', 'approve']),
      // mfa-tenant: only the Owner changes the MFA policy or resets a
      // member's MFA.
      ...P('security', ['view', 'configure']),
      // rls: the Owner administers data access (and is not restricted by it).
      ...P('data_access', ['view', 'configure']),
      // members: Owner-only workspace powers (roadmap 2.10).
      ...P('workspace', ['transfer', 'delete']),
      // backups: only the Owner may export all workspace data by default.
      ...P('data_exports', ['view', 'export']),
    ],
  },
  Admin: {
    description: 'Manages the tenant day to day',
    isSystem: false,
    permissions: [
      ...P('users', ['view', 'create', 'update']),
      ...P('roles', ['view']),
      ...P('settings', ['view', 'configure', 'update', 'delete']),
      ...P('feature_flags', ['view', 'configure', 'update', 'delete']),
      ...P('analytics', ['view', 'create', 'update', 'export']),
      ...P('connectors', ['view', 'create', 'update', 'configure', 'preview', 'sync']),
      ...P('dashboards', ['view', 'create', 'update']),
      ...P('reports', ['view', 'create', 'update', 'export']),
      ...P('notifications', ['view', 'configure', 'update', 'delete']),
      ...P('master_data', ['view']),
      ...P('email_templates', ['view', 'create', 'update']),
      ...P('alerts', ['view', 'create', 'update', 'evaluate']),
      ...P('api_keys', ['view', 'create', 'update']),
      ...P('embed', ['view', 'create']),
      // ai-catalogue: metric definitions.
      ...P('metrics', ['view', 'manage', 'approve']),
      // mfa-tenant: Admins see the policy and who has MFA.
      ...P('security', ['view']),
      // rls: Admins can read the data access rules.
      ...P('data_access', ['view']),
      // members: Admins change roles below their own and remove non-owners
      // (roadmap 2.10; the ceiling is enforced by tenantMember.service.js).
      ...P('users', ['delete']),
      ...P('roles', ['assign']),
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
      ...P('alerts', ['view', 'create', 'update', 'evaluate']),
      ...P('master_data', ['view']),
      ...P('api_keys', ['view']),
      ...P('embed', ['view']),
      // config: read which feature flags are on for the workspace.
      ...P('feature_flags', ['view']),
      // ai-catalogue: propose metric drafts; approval stays with Owner/Admin.
      ...P('metrics', ['view', 'manage']),
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
      ...P('alerts', ['view']),
      ...P('master_data', ['view']),
      // config: read which feature flags are on for the workspace.
      ...P('feature_flags', ['view']),
      // ai-catalogue: read the metric catalogue.
      ...P('metrics', ['view']),
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
  try {
    return await permissionRepository.createModule({
      key,
      name,
      description: '',
      isSystem: true,
      createdBy: by,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const createdByConcurrentInitializer = await permissionRepository.findModuleByKey(key);
    if (!createdByConcurrentInitializer) throw error;
    return createdByConcurrentInitializer;
  }
}

/** Ensure every built-in module exists (top-level first, then children). */
async function ensureModules({ by }) {
  for (const key of BUILTIN_MODULES) {
    await ensureModule(key, { name: titleCase(key), by });
  }
  for (const key of IAM_MODULES) {
    await ensureModule(key, { name: `IAM ${titleCase(key.split('.')[1])}`, by });
  }
  // members: tenant-only workspace module (roadmap 2.10).
  for (const key of MEMBERS_MODULES) {
    await ensureModule(key, { name: titleCase(key), by });
  }
}

/** Ensure the tenant-scoped permission keys exist (idempotent). */
async function ensurePermissions({ by }) {
  const catalogues = [TENANT_PERMISSION_ACTIONS, PLATFORM_PERMISSION_ACTIONS];
  for (const catalogue of catalogues) {
    for (const [moduleKey, actions] of Object.entries(catalogue)) {
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
}

/** Find a tenant-scoped role or create it (idempotent). Returns the role. */
async function ensureRole({ tenantId, name, description, isSystem, by }) {
  const existing = await roleRepository.findByName({ tenantId, name });
  if (existing) return existing;
  try {
    return await roleRepository.create({
      tenantId,
      name,
      description,
      level: 'tenant',
      isSystem,
      createdBy: by,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const createdByConcurrentInitializer = await roleRepository.findByName({ tenantId, name });
    if (!createdByConcurrentInitializer) throw error;
    return createdByConcurrentInitializer;
  }
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
  if (!['pending', 'active'].includes(tenant.status)) {
    throw ApiError.conflict('Only a pending or active tenant can be initialized');
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

  const updated = await tenantRepository.completeInitialization(tenantId, {
    onboardingStatus: 'ready',
    status: 'active',
    ownerId: ownerUser?._id ?? tenant.ownerId ?? null,
    updatedBy: by,
  });
  if (!updated) throw ApiError.conflict('Tenant lifecycle changed during initialization');

  await invalidateScope(tenantId);

  // Seed the usage counters from what exists now (the owner holds a seat).
  // Never fail onboarding over it: the daily reconcile corrects counters.
  await usageService.reconcile({ tenantId: String(tenantId), dryRun: false, by: by ?? 'system' }).catch(() => null);

  // billing (finding bil.09): provision the default subscription now. A
  // failure never fails onboarding: a tenant without a row resolves the
  // free plan anyway and the row is created on first billing access.
  await subscriptionService
    .ensureForTenant({ tenantId: String(tenantId), by, reason: 'Workspace initialization' })
    .catch((err) => logger.warn({ err: { message: err?.message }, tenantId: String(tenantId) }, 'Default subscription provisioning failed'));

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

/**
 * Idempotently bring an existing tenant's default roles up to the current
 * catalogue (new permission keys added since the tenant was initialised).
 * Only attaches permissions; never removes grants or touches custom roles.
 *
 * @returns {Promise<{ attached: number }>}
 */
export async function syncDefaultRolePermissions({ tenantId, by = 'migration', dryRun = false } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!dryRun) {
    await ensureModules({ by });
    await ensurePermissions({ by });
  }
  let attached = 0;
  for (const [name, def] of Object.entries(DEFAULT_ROLES)) {
    const role = await roleRepository.findByName({ tenantId, name });
    if (!role) continue;
    for (const permissionKey of def.permissions) {
      const permission = await permissionRepository.findPermissionByKey(permissionKey);
      if (!permission) continue;
      if (dryRun) { attached += 1; continue; }
      const joined = await roleRepository.attachPermission(role._id, permission._id, by);
      if (joined) attached += 1;
    }
  }
  if (!dryRun && attached) await invalidateScope(String(tenantId));
  return { attached };
}

export default {
  initialize,
  syncDefaultRolePermissions,
  DEFAULT_ROLES,
  TENANT_PERMISSION_ACTIONS,
  PLATFORM_PERMISSION_ACTIONS,
  _meta: { idempotent: true, module: 'iam.tenants' },
};
