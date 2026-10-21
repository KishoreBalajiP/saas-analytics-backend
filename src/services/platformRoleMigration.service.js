/**
 * Platform Role Migration Service (roadmap 2.1, audit doc 05 step M5).
 *
 * PURPOSE
 *   Moves existing platform administrators off the pre-2.1 all-permissions
 *   bootstrap roles (`super`, `platform`, `support`) onto the built-in
 *   platform role matching their `adminType` (super_admin, platform_admin,
 *   support_operator, auditor), WITHOUT ANY PRIVILEGE GAIN.
 *
 * RULES (per admin)
 *   - before = the admin's current effective permissions (live platform
 *     grants plus live grants for its own tenantScope).
 *   - target = the built-in role for its adminType.
 *   - If the target role grants anything the admin does not already hold,
 *     the admin is NOT changed and is reported as `needs_review` (an
 *     operator decides). This covers admins with no or custom roles.
 *   - Otherwise the target role is granted (platform grant) when missing,
 *     and every legacy bootstrap-role grant is revoked. Custom roles and
 *     tenant-scoped grants are never touched. after is a subset of before.
 *   - Super admins keep every permission (super_admin holds the whole
 *     catalogue), so the platform is never locked out.
 *
 * ORDER
 *   Run `npm run db:permissions -- --apply` first: it creates the built-in
 *   roles and supplies the legacy roles with current catalogue keys. Apply
 *   refuses to run while a built-in role is missing.
 *
 * SAFETY
 *   Dry run by default; the report lists every admin's before/after
 *   permission sets. Apply re-verifies each admin after writing.
 */

import { Admin } from '../models/Admin.js';
import { AdminRole } from '../models/AdminRole.js';
import roleRepository from '../repositories/role.repository.js';
import adminRepository from '../repositories/admin.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import {
  LEGACY_PLATFORM_ROLE_NAMES,
  PLATFORM_ROLES,
  ROLE_FOR_ADMIN_TYPE,
  permissionsForPlatformRole,
} from '../constants/platformRoles.js';
import { PLATFORM_CATALOGUE_KEYS } from './adminBootstrap.service.js';
import { invalidateAll } from './rbac.cache.service.js';

function liveFilter(now = new Date()) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

/** Load the built-in and legacy platform roles once. */
async function loadRoles() {
  const builtIn = new Map();
  for (const definition of PLATFORM_ROLES) {
    const role = await roleRepository.findByName({ tenantId: null, name: definition.name });
    builtIn.set(definition.name, role && role.isSystem ? role : null);
  }
  const legacyIds = new Set();
  for (const name of LEGACY_PLATFORM_ROLE_NAMES) {
    const role = await roleRepository.findByName({ tenantId: null, name });
    if (role && role.isSystem) legacyIds.add(String(role._id));
  }
  return { builtIn, legacyIds };
}

/** Permission keys per role id (memoised for the run). */
function rolePermissionLoader() {
  const cache = new Map();
  return async (roleId) => {
    const key = String(roleId);
    if (!cache.has(key)) {
      const perms = await roleRepository.listPermissionsForRole(key);
      cache.set(key, new Set(perms.map((p) => p.key)));
    }
    return cache.get(key);
  };
}

function union(sets) {
  const out = new Set();
  for (const set of sets) for (const key of set) out.add(key);
  return out;
}

function sorted(set) {
  return [...set].sort();
}

/** The admin's live grants that count towards its effective permissions. */
async function effectiveGrants(admin) {
  const scope = admin.tenantScope ? String(admin.tenantScope) : null;
  return AdminRole.find({
    adminId: String(admin._id),
    tenantId: scope ? { $in: [null, scope] } : null,
    ...liveFilter(),
  }).lean();
}

/**
 * Plan (and with `dryRun: false`, apply) the migration.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true]
 * @param {string} [opts.by='migration'] - attribution for new grants.
 * @returns {Promise<{ dryRun: boolean, rolesReady: boolean, warnings: string[], summary: Object, admins: Array<Object> }>}
 */
export async function migratePlatformRoles({ dryRun = true, by = 'migration' } = {}) {
  const { builtIn, legacyIds } = await loadRoles();
  const missing = [...builtIn.entries()].filter(([, role]) => !role).map(([name]) => name);
  const warnings = [];
  if (missing.length > 0) {
    const message = `built-in platform roles missing (${missing.join(', ')}): run \`npm run db:permissions -- --apply\` first`;
    if (!dryRun) throw new Error(message);
    warnings.push(`${message}; target permissions below come from the role definitions`);
  }

  const permissionsOf = rolePermissionLoader();
  const admins = await Admin.find({}).sort({ createdAt: 1 }).lean();
  const report = [];
  const summary = { total: admins.length, migrate: 0, unchanged: 0, needsReview: 0, applied: 0 };

  for (const admin of admins) {
    const adminId = String(admin._id);
    const targetName = ROLE_FOR_ADMIN_TYPE[admin.adminType] ?? null;
    const targetRole = targetName ? builtIn.get(targetName) : null;
    const targetPerms = targetRole
      ? await permissionsOf(targetRole._id)
      : new Set(permissionsForPlatformRole(targetName, PLATFORM_CATALOGUE_KEYS));

    const grants = await effectiveGrants(admin);
    const grantPerms = [];
    for (const grant of grants) grantPerms.push(await permissionsOf(grant.roleId));
    const before = union(grantPerms);

    const legacyGrants = grants.filter((g) => g.tenantId === null && legacyIds.has(String(g.roleId)));
    const holdsTarget = Boolean(targetRole) && grants.some((g) => g.tenantId === null && String(g.roleId) === String(targetRole._id));
    const remaining = grants.filter((g) => !legacyGrants.includes(g));
    const remainingPerms = [];
    for (const grant of remaining) remainingPerms.push(await permissionsOf(grant.roleId));
    const after = union([...remainingPerms, targetPerms]);

    const gained = sorted(new Set([...after].filter((key) => !before.has(key))));
    const removed = sorted(new Set([...before].filter((key) => !after.has(key))));

    const entry = {
      adminId,
      email: admin.email,
      adminType: admin.adminType,
      status: admin.status,
      tenantScope: admin.tenantScope ?? null,
      targetRole: targetName,
      action: 'migrate',
      grantTarget: !holdsTarget,
      revokeLegacyRoles: legacyGrants.map((g) => String(g.roleId)),
      before: sorted(before),
      after: sorted(after),
      gained,
      removed,
      applied: false,
    };

    if (!targetName) {
      entry.action = 'needs_review';
      entry.reason = `unknown adminType "${admin.adminType}"`;
    } else if (gained.length > 0) {
      // Never grant anything the admin does not already hold.
      entry.action = 'needs_review';
      entry.reason = `the ${targetName} role would add ${gained.length} permission(s) the admin does not hold`;
      entry.after = entry.before;
      entry.removed = [];
    } else if (holdsTarget && legacyGrants.length === 0) {
      entry.action = 'unchanged';
    }

    if (entry.action === 'migrate') summary.migrate += 1;
    else if (entry.action === 'unchanged') summary.unchanged += 1;
    else summary.needsReview += 1;

    if (!dryRun && entry.action === 'migrate') {
      if (!holdsTarget) {
        await adminRepository.assignRole(adminId, targetRole._id, { tenantId: null, by });
      }
      for (const grant of legacyGrants) {
        await adminRepository.revokeRole(adminId, grant.roleId, { tenantId: null });
      }
      // Verify: the written state must equal the plan (and gain nothing).
      const written = union(await Promise.all(
        (await effectiveGrants(admin)).map((g) => permissionsOf(g.roleId)),
      ));
      const unexpected = [...written].filter((key) => !before.has(key));
      if (unexpected.length > 0) {
        throw new Error(`migration verification failed for admin ${adminId}: gained ${unexpected.join(', ')}`);
      }
      entry.applied = true;
      summary.applied += 1;
    }
    report.push(entry);
  }

  if (!dryRun && summary.applied > 0) await invalidateAll();
  return { dryRun, rolesReady: missing.length === 0, warnings, summary, admins: report };
}

/** Resolve an admin's effective permissions (exported for verification). */
export async function effectivePermissionsFor(adminId) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) return [];
  const set = await permissionRepository.resolvePermissionsForActor({
    actorType: 'admin',
    actorId: String(admin._id),
    tenantId: admin.tenantScope ?? null,
  });
  return sorted(set);
}

export default { migratePlatformRoles, effectivePermissionsFor };
