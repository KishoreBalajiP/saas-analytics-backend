/**
 * Operator-controlled first platform-admin provisioning.
 *
 * This service is intentionally not mounted as an HTTP route and is only
 * called by the explicit bootstrap CLI. Existing administrators are never
 * updated or reset.
 *
 * roles: `syncPlatformCatalogue` is also called by the permission catalogue
 * migration (`npm run db:permissions`).
 *
 * PLATFORM ROLES (roadmap 2.1)
 *   The four built-in platform roles (super_admin, platform_admin,
 *   support_operator, auditor) are defined in `constants/platformRoles.js`.
 *   `ensurePlatformRoles` creates them and converges each one to exactly its
 *   definition (missing keys attached, extra keys detached), so a deployment
 *   always matches the code. The pre-2.1 all-permissions bootstrap roles
 *   (`super`, `platform`, `support`) are left alone except that `super` and
 *   `platform` keep receiving new catalogue keys, as before, until
 *   `npm run db:platform-roles` moves their holders onto the built-in roles.
 */

import ApiError from '../utils/ApiError.js';
import { hash as hashPassword } from '../utils/password.js';
import adminRepository from '../repositories/admin.repository.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { ADMIN_TYPES } from '../models/Admin.js';
import { BUILTIN_MODULES, IAM_MODULES, BILLING_MODULES, CONFIG_MODULES } from '../models/Module.js';
import { CANONICAL_ACTIONS } from '../models/Permission.js';
import {
  PLATFORM_ROLES,
  ROLE_FOR_ADMIN_TYPE,
  permissionsForPlatformRole,
} from '../constants/platformRoles.js';
import { invalidateAll } from './rbac.cache.service.js';
// detection: security alert permissions (roadmap 2.6).
import { SECURITY_MODULES } from '../models/Module.js';

const PLATFORM_ROLE_PERMISSIONS = Object.freeze([
  ...BUILTIN_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
  ...IAM_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
  ...BILLING_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
  // detection: security.alerts.* (super + platform; auditor should get view only).
  ...SECURITY_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
]);


// config: secret settings permissions (roadmap 2.4). Registered in the
// platform catalogue; granted to the `super` bootstrap role only (the
// `platform` role manages plain settings, flags and templates).
const CONFIG_PERMISSION_ACTIONS = Object.freeze({ 'settings.secrets': ['view', 'update'] });
const CONFIG_SUPER_PERMISSIONS = Object.freeze(
  CONFIG_MODULES.flatMap((module) => (CONFIG_PERMISSION_ACTIONS[module] ?? []).map((action) => `${module}.${action}`)),
);
const rolePermissions = (roleName) => (roleName === 'super'
  ? [...PLATFORM_ROLE_PERMISSIONS, ...CONFIG_SUPER_PERMISSIONS]
  : PLATFORM_ROLE_PERMISSIONS);

// roles: every key of the platform permission catalogue (`module.action`
// for each catalogue module and canonical action). The built-in super_admin
// role holds all of them; the other built-in roles hold explicit subsets
// (`constants/platformRoles.js`). New platform keys join the catalogue by
// registering their module in `models/Module.js`.
// config: the secret settings keys are catalogue keys too, so super_admin
// holds them; platform_admin and the others do not list them.
export const PLATFORM_CATALOGUE_KEYS = Object.freeze([...PLATFORM_ROLE_PERMISSIONS, ...CONFIG_SUPER_PERMISSIONS]);

async function ensureConfigCatalogue(by) {
  for (const key of CONFIG_MODULES) {
    let module = await permissionRepository.findModuleByKey(key);
    if (!module) {
      module = await permissionRepository.createModule({
        key,
        name: titleCase(key),
        parentKey: key.slice(0, key.indexOf('.')),
        isSystem: true,
        createdBy: by,
      });
    }
    for (const action of CONFIG_PERMISSION_ACTIONS[key] ?? []) {
      await permissionRepository.registerAction({
        moduleId: module._id,
        module: key,
        action,
        description: `${titleCase(action)} ${titleCase(key)}`,
        isSystem: true,
        createdBy: by,
      });
    }
  }
}

function titleCase(value) {
  return value
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function ensurePlatformCatalogue(by) {
  const modules = [...BUILTIN_MODULES, ...IAM_MODULES, ...BILLING_MODULES];
  // detection: register the security alert module (roadmap 2.6).
  modules.push(...SECURITY_MODULES);
  for (const key of modules) {
    let module = await permissionRepository.findModuleByKey(key);
    if (!module) {
      module = await permissionRepository.createModule({
        key,
        name: titleCase(key),
        parentKey: key.includes('.') ? key.slice(0, key.indexOf('.')) : null,
        isSystem: true,
        createdBy: by,
      });
    }
    for (const action of CANONICAL_ACTIONS) {
      await permissionRepository.registerAction({
        moduleId: module._id,
        module: key,
        action,
        description: `${titleCase(action)} ${titleCase(key)}`,
        isSystem: true,
        createdBy: by,
      });
    }
  }
  await ensureConfigCatalogue(by);
}

/**
 * Create the built-in platform roles when missing and converge each one to
 * exactly its definition. A non-system role that already uses a built-in
 * name is never adopted; it is reported as a conflict and skipped.
 *
 * @param {Object} [opts]
 * @param {string} [opts.by='migration'] - attribution for created rows.
 * @param {boolean} [opts.dryRun=false] - report without writing.
 * @returns {Promise<Array<{ name: string, created: boolean, attached: number, detached: number, conflict: boolean, roleId: string|null }>>}
 */
export async function ensurePlatformRoles({ by = 'migration', dryRun = false } = {}) {
  const report = [];
  let changed = false;
  for (const definition of PLATFORM_ROLES) {
    const wanted = permissionsForPlatformRole(definition.name, PLATFORM_CATALOGUE_KEYS);
    const entry = { name: definition.name, created: false, attached: 0, detached: 0, conflict: false, roleId: null };
    report.push(entry);

    let role = await roleRepository.findByName({ tenantId: null, name: definition.name });
    if (role && !role.isSystem) {
      entry.conflict = true;
      continue;
    }
    if (!role) {
      entry.created = true;
      if (dryRun) {
        entry.attached = wanted.length;
        continue;
      }
      role = await roleRepository.create({
        tenantId: null,
        name: definition.name,
        description: definition.description,
        level: 'platform',
        isSystem: true,
        createdBy: by,
      });
      changed = true;
    }
    entry.roleId = String(role._id);

    const current = await roleRepository.listPermissionsForRole(role._id);
    const currentKeys = new Set(current.map((p) => p.key));
    const wantedKeys = new Set(wanted);
    for (const key of wanted) {
      if (currentKeys.has(key)) continue;
      const permission = await permissionRepository.findPermissionByKey(key);
      if (!permission) {
        // Only possible in a dry run before the catalogue exists.
        if (dryRun) entry.attached += 1;
        continue;
      }
      entry.attached += 1;
      if (!dryRun) {
        await roleRepository.attachPermission(role._id, permission._id, by);
        changed = true;
      }
    }
    for (const permission of current) {
      if (wantedKeys.has(permission.key)) continue;
      entry.detached += 1;
      if (!dryRun) {
        await roleRepository.detachPermission(role._id, permission._id);
        changed = true;
      }
    }
  }
  if (changed) await invalidateAll();
  return report;
}

/**
 * Create the first administrator without changing an existing account and
 * grant the built-in platform role matching its `adminType`.
 * Re-running with the same email is a successful no-op.
 */
export async function bootstrapAdmin({ email, password, adminType = 'super', name = '' } = {}) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) throw ApiError.badRequest('Admin email is required');
  if (!password || password.length < 8) {
    throw ApiError.badRequest('Bootstrap password must be at least 8 characters');
  }
  if (!ADMIN_TYPES.includes(adminType)) {
    throw ApiError.badRequest(`adminType must be one of ${ADMIN_TYPES.join(', ')}`);
  }

  const existing = await adminRepository.findByEmail(normalizedEmail);
  if (existing) {
    return { created: false, admin: existing, role: null };
  }

  const passwordHash = await hashPassword(password);
  const admin = await adminRepository.create({
    email: normalizedEmail,
    passwordHash,
    adminType,
    status: 'active',
    profile: { name },
    createdBy: 'bootstrap',
  });

  const by = admin._id.toString();
  await ensurePlatformCatalogue(by);
  await ensurePlatformRoles({ by });
  const role = await roleRepository.findByName({ tenantId: null, name: ROLE_FOR_ADMIN_TYPE[adminType] });
  if (!role || !role.isSystem) {
    throw ApiError.conflict(`Built-in platform role "${ROLE_FOR_ADMIN_TYPE[adminType]}" is unavailable`);
  }
  await adminRepository.assignRole(by, role._id, { tenantId: null, by });

  return { created: true, admin: { ...admin, passwordHash: undefined }, role };
}

/**
 * Idempotently (re)apply the platform permission catalogue, create and
 * converge the built-in platform roles, and keep the legacy `super` /
 * `platform` bootstrap roles supplied with every catalogue key. Used by
 * `npm run db:permissions` so deployments created before a catalogue change
 * receive the new keys and roles.
 *
 * @returns {Promise<{ roles: string[], attached: number, builtIn: Array<Object> }>}
 *   `roles`/`attached` describe the legacy roles; `builtIn` the built-in ones.
 */
export async function syncPlatformCatalogue({ by = 'migration', dryRun = false } = {}) {
  if (!dryRun) await ensurePlatformCatalogue(by);
  const builtIn = await ensurePlatformRoles({ by, dryRun });
  const roles = [];
  let attached = 0;
  for (const name of ['super', 'platform']) {
    const role = await roleRepository.findByName({ tenantId: null, name });
    if (!role) continue;
    roles.push(name);
    for (const key of rolePermissions(name)) {
      const permission = await permissionRepository.findPermissionByKey(key);
      if (!permission) continue;
      if (dryRun) { attached += 1; continue; }
      const joined = await roleRepository.attachPermission(role._id, permission._id, by);
      if (joined) attached += 1;
    }
  }
  if (!dryRun && attached > 0) await invalidateAll();
  return { roles, attached, builtIn };
}

export default {
  bootstrapAdmin,
  syncPlatformCatalogue,
  ensurePlatformRoles,
  PLATFORM_CATALOGUE_KEYS,
};
