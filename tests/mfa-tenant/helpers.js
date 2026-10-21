/**
 * Shared helpers for the tenant-user MFA suites (mfa-tenant).
 *
 * Onboards real workspaces (default Owner/Admin/Manager/Viewer roles), signs
 * members in over HTTP and drives the TOTP flows with locally minted codes
 * (`tests/helpers/totp.js`, RFC 6238, same parameters as the service).
 */

import assert from 'node:assert/strict';
import { api, refreshCookieFrom } from '../helpers/http.js';
import { totpCode } from '../helpers/totp.js';
import clock from '../../src/utils/clock.js';
import { shortToken } from '../../src/utils/id.js';
import { hash } from '../../src/utils/password.js';
import * as tenantService from '../../src/services/tenant.service.js';
import roleRepository from '../../src/repositories/role.repository.js';
import userRepository from '../../src/repositories/user.repository.js';
import { UserRole } from '../../src/models/UserRole.js';
import rbacCache from '../../src/services/rbac.cache.service.js';

export const PASSWORD = 'Password123!';

/** Authorization + tenant headers for an access token. */
export function authHeaders(token, tenantId) {
  return { authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId };
}

/** POST /auth/login for a tenant member. */
export function login(tenantId, email, body = {}) {
  return api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: { email, password: PASSWORD, ...body },
  });
}

/** Sign in and return the access token, headers and refresh cookie. */
export async function signIn(tenantId, email, body = {}) {
  const res = await login(tenantId, email, body);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return {
    res,
    token: res.json.data.accessToken,
    auth: authHeaders(res.json.data.accessToken, tenantId),
    cookie: refreshCookieFrom(res, 'saas_session'),
  };
}

/** Onboard a workspace with an active Owner; returns ids and the Owner session. */
export async function onboard() {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `MFA ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  const tenantId = tenant._id.toString();
  const ownerUser = await userRepository.findByEmail(tenantId, owner.email);
  const session = await signIn(tenantId, owner.email);
  return { tenantId, owner: { ...owner, id: String(ownerUser._id) }, ownerSession: session };
}

/** Create an active member holding one of the default roles. */
export async function addMember(tenantId, roleName = 'Viewer') {
  const email = `${roleName.toLowerCase()}-${shortToken(10).toLowerCase()}@example.com`;
  const user = await userRepository.create({
    tenantId,
    email,
    status: 'active',
    passwordHash: await hash(PASSWORD),
    profile: { name: roleName },
  });
  if (roleName) {
    const role = await roleRepository.findByName({ tenantId, name: roleName });
    assert.ok(role, `role ${roleName} exists`);
    await new UserRole({ tenantId, userId: String(user._id), roleId: String(role._id), grantedAt: new Date() }).save();
    await rbacCache.clearAll();
  }
  return { id: String(user._id), email };
}

/**
 * TOTP time control. Codes are accepted once (each challenge needs a newer
 * time step), so tests step the service's injectable clock forward one
 * period per challenge and mint the code for that instant.
 */
let step = 0;
let base = Date.now();

/** Start a fresh timeline (call in beforeEach). */
export function resetTotpClock() {
  step = 0;
  base = Date.now();
  clock.set(new Date(base));
}

/** Return the service clock to real time (call in afterEach). */
export function restoreClock() {
  clock.reset();
}

/** Advance one TOTP period and return a valid code for that instant. */
export function nextCode(secret) {
  step += 1;
  const at = base + step * 30 * 1000;
  clock.set(new Date(at));
  return totpCode(secret, { epoch: at });
}

/** A code for the current (already used, unless fresh) instant. */
export function sameCode(secret) {
  return totpCode(secret, { epoch: clock.now().getTime() });
}

/**
 * Enrol MFA for a signed-in member (enroll + verify). Returns the secret
 * and the one-time recovery codes.
 */
export async function enrollMfa(auth) {
  const start = await api('/api/v1/auth/mfa/enroll', { method: 'POST', headers: auth });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const { secret } = start.json.data;
  const verify = await api('/api/v1/auth/mfa/verify', { method: 'POST', headers: auth, body: { code: nextCode(secret) } });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return { secret, recoveryCodes: verify.json.data.recoveryCodes, start, verify };
}
