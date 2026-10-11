/**
 * Operator-controlled first platform-admin provisioning.
 *
 * This service is intentionally not mounted as an HTTP route and is only
 * called by the explicit bootstrap CLI. Existing administrators are never
 * updated or reset.
 */

import ApiError from '../utils/ApiError.js';
import { hash as hashPassword } from '../utils/password.js';
import adminRepository from '../repositories/admin.repository.js';
import roleRepository from '../repositories/role.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { ADMIN_TYPES } from '../models/Admin.js';
import { BUILTIN_MODULES, IAM_MODULES } from '../models/Module.js';
import { CANONICAL_ACTIONS } from '../models/Permission.js';

const PLATFORM_ROLE_PERMISSIONS = Object.freeze([
  ...BUILTIN_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
  ...IAM_MODULES.flatMap((module) => CANONICAL_ACTIONS.map((action) => `${module}.${action}`)),
]);

function titleCase(value) {
  return value
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function ensurePlatformCatalogue(by) {
  const modules = [...BUILTIN_MODULES, ...IAM_MODULES];
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
}

/**
 * Create the first administrator without changing an existing account.
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

  await ensurePlatformCatalogue(admin._id.toString());
  let role = await roleRepository.findByName({ tenantId: null, name: adminType });
  if (!role) {
    role = await roleRepository.create({
      tenantId: null,
      name: adminType,
      description: `Bootstrap ${adminType} platform administrator`,
      level: 'platform',
      isSystem: true,
      createdBy: admin._id.toString(),
    });
  }

  for (const key of PLATFORM_ROLE_PERMISSIONS) {
    await roleRepository.attachPermission(
      role._id,
      (await permissionRepository.findPermissionByKey(key))._id,
      admin._id.toString(),
    );
  }
  await adminRepository.assignRole(admin._id.toString(), role._id, {
    tenantId: null,
    by: admin._id.toString(),
  });

  return { created: true, admin: { ...admin, passwordHash: undefined }, role };
}

export default { bootstrapAdmin };
