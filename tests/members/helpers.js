/**
 * Shared fixtures for the members package tests (roadmap 2.10).
 *
 * Builds real, initialised workspaces (default roles, Owner grant, usage
 * counters) and signs members in over HTTP so every check runs through the
 * real middleware (authenticate, resolveTenant, permission) and services.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api } from '../helpers/http.js';
import { hash } from '../../src/utils/password.js';
import tenantService from '../../src/services/tenant.service.js';
import subscriptionService from '../../src/services/subscription.service.js';
import usageService from '../../src/services/usage.service.js';
import userRepository from '../../src/repositories/user.repository.js';
import roleRepository from '../../src/repositories/role.repository.js';
import usageCounterRepository from '../../src/repositories/usageCounter.repository.js';
import { invalidateScope } from '../../src/services/rbac.cache.service.js';
import { UserRole } from '../../src/models/UserRole.js';

export const PASSWORD = 'MembersPassword123!';

let hashed = null;
async function passwordHash() {
  hashed = hashed ?? (await hash(PASSWORD));
  return hashed;
}

/**
 * An active, initialised workspace on the `pro` plan (25 seats) whose Owner
 * can sign in with PASSWORD.
 */
export async function createWorkspace(label = 'Members') {
  const suffix = randomBytes(3).toString('hex');
  const ownerEmail = `owner-${suffix}@example.com`;
  const result = await tenantService.create({
    tenant: { name: `${label} ${suffix}` },
    owner: { email: ownerEmail, name: 'Olive Owner', password: PASSWORD },
    initialize: true,
    by: 'platform-admin',
  });
  const tenantId = String(result.tenant._id);
  await subscriptionService.createForTenant({ tenantId, planId: 'pro' });
  return { tenant: result.tenant, tenantId, owner: result.owner, ownerEmail };
}

/** Add an active member holding `roleName` (counts a seat like a real join). */
export async function addMember({ tenantId, roleName, email, status = 'active', name }) {
  const address = email ?? `${roleName.toLowerCase()}-${randomBytes(3).toString('hex')}@example.com`;
  const user = await userRepository.create({
    tenantId,
    email: address,
    passwordHash: await passwordHash(),
    status,
    profile: { name: name ?? `${roleName} Member`, locale: 'en', timezone: 'UTC' },
    acceptedAt: new Date(),
  });
  if (roleName) {
    const role = await roleRepository.findByName({ tenantId, name: roleName });
    assert.ok(role, `role ${roleName} exists`);
    await new UserRole({ tenantId, userId: String(user._id), roleId: String(role._id) }).save();
  }
  await invalidateScope(tenantId);
  await usageService.reconcile({ tenantId, dryRun: false, by: 'test' }).catch(() => null);
  return user;
}

/** Sign a member in; returns `{ Authorization }` headers. */
export async function signIn(tenant, email, password = PASSWORD) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenant.slug },
    body: { email, password },
  });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.json)}`);
  return { Authorization: `Bearer ${res.json.data.accessToken}` };
}

/** Role id by name in a tenant. */
export async function roleId(tenantId, name) {
  const role = await roleRepository.findByName({ tenantId, name });
  assert.ok(role, `role ${name} exists`);
  return String(role._id);
}

/** Role names a member holds (live unscoped grants). */
export async function roleNamesOf(tenantId, userId) {
  const grants = await UserRole.find({ tenantId, userId: String(userId) }).lean();
  const names = [];
  for (const grant of grants) {
    const role = await roleRepository.findById(grant.roleId);
    if (role) names.push(role.name);
  }
  return names.sort();
}

/** Current value of a usage counter. */
export async function seatCount(tenantId) {
  return (await usageCounterRepository.findOne(tenantId, 'members', 'current'))?.value ?? 0;
}
