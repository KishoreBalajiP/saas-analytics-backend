/**
 * Auth test helpers - mint tokens, build bearer headers, etc.
 *
 * WHY IT EXISTS
 *   Sprint 1 will introduce real auth; until then we provide test helpers
 *   so future tests can assert role / tenant boundaries without waiting on
 *   the real auth feature.
 *
 * USAGE
 *   ```js
 *   import { bearerFor, adminBearerFor, withTenant } from './auth.js';
 *
 *   const headers = { authorization: bearerFor({ id: 'usr_01H...', roles: ['owner'] }) };
 *   ```
 */

import env from '../../src/config/env.js';
import { sign, JWT_AUDIENCES } from '../../src/utils/jwt.js';

/**
 * Mint a `Bearer` token for a tenant user.
 *
 * @param {Object} claims - { id, email?, roles?, tenantId? }.
 * @param {Object} [opts] - sign options.
 * @returns {Promise<string>}
 */
export async function bearerFor(claims, opts = {}) {
  const payload = {
    sub: claims.id,
    email: claims.email,
    roles: claims.roles ?? ['member'],
    tenantId: claims.tenantId ?? null,
  };
  const token = await sign({
    payload,
    audience: opts.audience ?? JWT_AUDIENCES.USER,
    expiresIn: opts.expiresIn ?? '15m',
    subject: claims.id,
  });
  return `Bearer ${token}`;
}

/**
 * Mint a `Bearer` token for an admin user.
 *
 * @param {Object} claims - { id, email?, type? }.
 * @param {Object} [opts]
 * @returns {Promise<string>}
 */
export async function adminBearerFor(claims, opts = {}) {
  const payload = {
    sub: claims.id,
    email: claims.email,
    type: claims.type ?? 'platform',
  };
  const token = await sign({
    payload,
    audience: opts.audience ?? JWT_AUDIENCES.ADMIN,
    expiresIn: opts.expiresIn ?? '15m',
    subject: claims.id,
  });
  return `Bearer ${token}`;
}

/**
 * Build a request headers object that includes the tenant id header.
 *
 * @param {string} tenantId
 * @param {Object} [extra]
 * @returns {Object}
 */
export function withTenant(tenantId, extra = {}) {
  return { 'X-Tenant-Id': tenantId, ...extra };
}

/**
 * Build the standard `Authorization: Bearer ...` header from a raw token.
 *
 * @param {string} token
 * @returns {{ authorization: string }}
 */
export function asBearer(token) {
  return { authorization: `Bearer ${token}` };
}

export default { bearerFor, adminBearerFor, withTenant, asBearer };
