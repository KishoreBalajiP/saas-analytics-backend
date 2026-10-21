/**
 * Shared fixtures for the platform-role tests (roadmap 2.1).
 *
 * Seeds the real platform catalogue and built-in roles exactly as
 * `npm run db:permissions` would, then creates admins holding them.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api } from '../helpers/http.js';
import adminService from '../../src/services/admin.service.js';
import adminBootstrapService from '../../src/services/adminBootstrap.service.js';
import roleRepository from '../../src/repositories/role.repository.js';

export const PASSWORD = 'PlatformRoles123!';

/** Create the platform catalogue and the four built-in roles. */
export async function seedPlatformRoles() {
  return adminBootstrapService.syncPlatformCatalogue({ by: 'test' });
}

/** The stored built-in role row named `name`. */
export async function builtInRole(name) {
  const role = await roleRepository.findByName({ tenantId: null, name });
  assert.ok(role, `built-in role ${name} must exist`);
  return role;
}

/**
 * Create an active admin (system caller) and optionally grant a role by
 * name. `grantTenantId` makes the grant tenant-scoped.
 */
export async function createAdmin({ adminType = 'platform', roleName = null, tenantScope = null, grantTenantId = null } = {}) {
  const admin = await adminService.create({
    email: `${adminType}-${randomBytes(4).toString('hex')}@platform.test`,
    password: PASSWORD,
    adminType,
    name: `${adminType} admin`,
    tenantScope,
    by: null,
  });
  if (roleName) {
    const role = await builtInRole(roleName);
    await adminService.assignRole({ adminId: String(admin._id), roleId: String(role._id), tenantId: grantTenantId, by: null });
  }
  return admin;
}

/** Log an admin in and return its bearer header. */
export async function loginAdmin(admin) {
  const res = await api('/api/v1/admin-auth/login', {
    method: 'POST',
    body: { email: admin.email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `admin login failed: ${JSON.stringify(res.json)}`);
  return { authorization: `Bearer ${res.json.data.accessToken}` };
}

/** Create an admin with a built-in role and log it in. */
/**
 * adminauth: re-authenticate an admin session (password only here: the test
 * suite runs without the MFA policy) so step-up-gated actions are allowed.
 */
export async function stepUpSession(auth) {
  const res = await api('/api/v1/admin-auth/step-up', { method: 'POST', headers: auth, body: { password: PASSWORD } });
  if (res.status !== 200) throw new Error(`step-up failed: ${res.status} ${JSON.stringify(res.json)}`);
  return auth;
}

export async function adminSession(opts) {
  const admin = await createAdmin(opts);
  return { admin, auth: await loginAdmin(admin) };
}
