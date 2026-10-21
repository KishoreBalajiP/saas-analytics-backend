/**
 * Admin authentication flow helpers (adminauth, roadmap 2.2).
 *
 * Small wrappers over the real HTTP API for the admin-auth suites: sign in,
 * enrol MFA (TOTP codes come from the RFC 6238 helper), step up, and seed
 * admins that hold the full platform permission catalogue.
 */

import assert from 'node:assert/strict';
import { api, refreshCookieFrom } from './http.js';
import { totpCode } from './totp.js';
import adminBootstrapService from '../../src/services/adminBootstrap.service.js';

export const ADMIN_AUTH = '/api/v1/admin-auth';
export const ADMIN = '/api/v1/admin';
export const PASSWORD = 'Password123!';

let counter = 0;

/** `{ authorization: 'Bearer ...' }` */
export function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** POST /admin-auth/login with optional second factor. */
export function adminLogin(email, password = PASSWORD, extra = {}) {
  return api(`${ADMIN_AUTH}/login`, { method: 'POST', body: { email, password, ...extra } });
}

/**
 * Seed an active admin of `adminType` that holds every platform permission
 * (bootstrap path: role named after the type, full catalogue attached).
 */
export async function seedPrivilegedAdmin(adminType = 'super', { email } = {}) {
  counter += 1;
  const address = email ?? `${adminType}-${Date.now()}-${counter}@platform.test`;
  const { admin } = await adminBootstrapService.bootstrapAdmin({
    email: address,
    password: PASSWORD,
    adminType,
    name: `${adminType} admin`,
  });
  return admin;
}

/** Enrol MFA on an authenticated (possibly enrolment-only) session. */
export async function enrolMfa(token) {
  const enroll = await api(`${ADMIN_AUTH}/mfa/enroll`, { method: 'POST', headers: bearer(token) });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.json));
  const { secret } = enroll.json.data;
  const verify = await api(`${ADMIN_AUTH}/mfa/verify`, {
    method: 'POST',
    headers: bearer(token),
    body: { code: totpCode(secret) },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return { secret, recoveryCodes: verify.json.data.recoveryCodes, verify };
}

/**
 * Sign in an admin and make sure MFA is enrolled: returns a usable token,
 * the TOTP secret, the recovery codes and the refresh cookie.
 */
export async function signInEnrolled(admin, password = PASSWORD) {
  const login = await adminLogin(admin.email, password);
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.json.data.accessToken;
  const { secret, recoveryCodes } = await enrolMfa(token);
  return { token, secret, recoveryCodes, cookie: refreshCookieFrom(login), login };
}

/** Sign in again with password + current TOTP code. */
export async function signInWithCode(admin, secret, password = PASSWORD) {
  const login = await adminLogin(admin.email, password, { mfaToken: totpCode(secret) });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.data.accessToken, cookie: refreshCookieFrom(login), login };
}

/** POST /admin-auth/step-up with password + current TOTP code. */
export function stepUp(token, secret, { password = PASSWORD, code } = {}) {
  return api(`${ADMIN_AUTH}/step-up`, {
    method: 'POST',
    headers: bearer(token),
    body: { password, ...(secret || code ? { code: code ?? totpCode(secret) } : {}) },
  });
}

/** A fresh super admin with MFA enrolled and a fresh step-up. */
export async function steppedUpSuper() {
  const admin = await seedPrivilegedAdmin('super');
  const session = await signInEnrolled(admin);
  const res = await stepUp(session.token, session.secret);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { admin, ...session };
}

export default {
  ADMIN_AUTH,
  ADMIN,
  PASSWORD,
  bearer,
  adminLogin,
  seedPrivilegedAdmin,
  enrolMfa,
  signInEnrolled,
  signInWithCode,
  stepUp,
  steppedUpSuper,
};
