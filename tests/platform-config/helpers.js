/**
 * Shared fixtures for the platform configuration tests (roadmap 2.4):
 * platform admins holding exactly the permissions a test names, tenant
 * owners/members, and a log capture for "never logged" assertions.
 */

import assert from 'node:assert/strict';
import pino from 'pino';
import { api } from '../helpers/http.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import adminService from '../../src/services/admin.service.js';
import roleService from '../../src/services/role.service.js';
import permissionService from '../../src/services/permission.service.js';
import * as tenantService from '../../src/services/tenant.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import { Admin } from '../../src/models/Admin.js';
import { Role } from '../../src/models/Role.js';
import { UserRole } from '../../src/models/UserRole.js';
import logger from '../../src/utils/logger.js';

export const PASSWORD = 'Password123!';

async function ensureModule(key) {
  if (key.includes('.')) await ensureModule(key.slice(0, key.lastIndexOf('.')));
  try {
    await permissionService.createModule({ key, name: key });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

async function ensurePermission(key) {
  const module = key.slice(0, key.lastIndexOf('.'));
  const action = key.slice(key.lastIndexOf('.') + 1);
  await ensureModule(module);
  try {
    await permissionService.createPermission({ module, action });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

/**
 * A logged-in platform admin holding exactly `permissions`.
 * `tenantScope` makes it a tenant-scoped (support) admin.
 *
 * @returns {Promise<{ admin: object, headers: object }>}
 */
export async function adminWith(permissions = [], { tenantScope = null } = {}) {
  const admin = await adminService.create({
    email: `cfg-${shortToken(10).toLowerCase()}@platform.test`,
    password: PASSWORD,
    adminType: 'platform',
    name: 'Config Admin',
  });
  if (permissions.length) {
    const role = await roleService.create({ tenantId: null, name: `cfg_${shortToken(10)}` });
    for (const key of permissions) {
      await ensurePermission(key);
      await roleService.addPermission({ roleId: role._id, permissionKey: key, by: null /* fixture seeding */ });
    }
    await adminService.assignRole({ adminId: admin._id, roleId: role._id, tenantId: null, by: null /* fixture seeding */ });
  }
  if (tenantScope) await Admin.updateOne({ _id: admin._id }, { $set: { tenantScope: String(tenantScope) } });
  const login = await api('/api/v1/admin-auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(login.json)}`);
  return { admin, headers: { authorization: `Bearer ${login.json.data.accessToken}` } };
}

/** An onboarded workspace with its logged-in Owner. */
export async function onboardTenant() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Cfg ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email: owner.email, password: PASSWORD } });
  assert.equal(login.status, 200, `owner login failed: ${JSON.stringify(login.json)}`);
  return { tenantId, email: owner.email, headers: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

/** A logged-in member of `tenantId` holding the named default role (or none). */
export async function memberOf(tenantId, roleName = null) {
  const email = `member-${shortToken(10).toLowerCase()}@example.com`;
  const user = await userRepository.create({ tenantId, email, status: 'active', passwordHash: await hash(PASSWORD), profile: { name: 'Member' } });
  if (roleName) {
    const role = await Role.findOne({ tenantId, name: roleName }).lean();
    assert.ok(role, `role ${roleName} exists`);
    await UserRole.create({ tenantId, userId: String(user._id), roleId: String(role._id), createdBy: 'test' });
  }
  const login = await api('/api/v1/auth/login', { method: 'POST', headers: { 'X-Tenant-Id': tenantId }, body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, `member login failed: ${JSON.stringify(login.json)}`);
  return { headers: { authorization: `Bearer ${login.json.data.accessToken}`, 'X-Tenant-Id': tenantId } };
}

/**
 * Capture every line the app logger writes while `fn` runs.
 *
 * @returns {Promise<string>} the captured output.
 */
export async function captureLogs(fn) {
  const stream = logger[pino.symbols.streamSym];
  const original = stream.write;
  const lines = [];
  stream.write = function write(chunk, ...rest) {
    lines.push(String(chunk));
    return original.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    stream.write = original;
  }
  return lines.join('');
}

/** adminauth: take a fresh step-up on an admin session (secret reads need one). */
export async function stepUp(headers) {
  const res = await api('/api/v1/admin-auth/step-up', { method: 'POST', headers, body: { password: PASSWORD } });
  if (res.status !== 200) throw new Error(`step-up failed: ${res.status} ${JSON.stringify(res.json)}`);
  return headers;
}
