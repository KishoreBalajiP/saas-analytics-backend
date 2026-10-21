/**
 * Actor Status Service (auth hardening).
 *
 * PURPOSE
 *   Answers "may this already-authenticated identity still act right now?"
 *   on every authenticated request and socket handshake. A valid access
 *   token and a live session are not enough: the account itself must still
 *   be `active`, and a tenant user's workspace must still be `active`.
 *   Without this, suspending a user or a tenant left their existing access
 *   tokens working until they expired.
 *
 * RESPONSIBILITY
 *   - assertActorActive({ actorType, actorId }) -> throws a typed 401
 *     (`ACCOUNT_SUSPENDED` | `ACCOUNT_NOT_ACTIVE` | `TENANT_NOT_ACTIVE`).
 *   - A short in-process cache of status lookups
 *     (`AUTH_STATUS_CACHE_TTL_MS`, default 5 s; 0 disables it).
 *   - Immediate invalidation: every User / Admin / Tenant change made
 *     through Mongoose (`save`, `findOneAndUpdate`, soft delete, hard
 *     delete) drops the cached entry in this process, so a suspension
 *     applies on the very next request here; a bulk write (`updateOne` /
 *     `updateMany` / `deleteMany`, no single document) drops the whole
 *     cache. Other instances pick it up within the TTL.
 *
 * DESIGN NOTES
 *   - The user's tenant is taken from the user record (authoritative), not
 *     from the token.
 *   - The tenant rule is the one background work uses (`jobs/tenantGuard`
 *     `isTenantActive`): only `active` passes, a missing or malformed id is
 *     not active, and a failed lookup throws (`onLookupError: 'throw'`), so
 *     a database outage fails the request instead of reading as a
 *     suspension.
 *   - Only `active` passes (allow-list), matching the login gate.
 *   - Cached values are plain statuses (strings, or a boolean for tenants);
 *     nothing secret is kept.
 */

import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { ERROR_CODES } from '../../../config/constants.js';
import userRepository from '../../../repositories/user.repository.js';
import adminRepository from '../../../repositories/admin.repository.js';
import { isTenantActive } from '../../../jobs/tenantGuard.js';
import { auditRegistry } from '../../../models/plugins/audit.js';

const TTL_MS = Math.max(0, Number(env.security.auth.statusCacheTtlMs) || 0);
const MAX_ENTRIES = 10000;

/** key -> { value, expiresAt } */
const cache = new Map();

/**
 * Bumped on every invalidation. A lookup that started before a change must
 * not write its (possibly stale) answer back into the cache afterwards.
 */
let epoch = 0;

const KIND_BY_MODULE = Object.freeze({
  'iam.users': 'user',
  'iam.admins': 'admin',
  'iam.tenants': 'tenant',
});

const cacheKey = (kind, id) => `${kind}:${id}`;

/** Drop one cached status (e.g. after a status change). */
export function invalidate(kind, id) {
  if (!id) return;
  epoch += 1;
  cache.delete(cacheKey(kind, String(id)));
}

/** Drop every cached status (tests, or a hard reset). */
export function clear() {
  epoch += 1;
  cache.clear();
}

async function cached(kind, id, load) {
  if (TTL_MS === 0) return load();
  const key = cacheKey(kind, id);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const startedAt = epoch;
  const value = await load();
  if (epoch === startedAt) {
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  }
  return value;
}

/** A malformed id (e.g. not an ObjectId) means "no such record". */
async function safeFind(find, id) {
  try {
    return await find(id);
  } catch (err) {
    if (err?.name === 'CastError') return null;
    throw err;
  }
}

/**
 * Current status of an account (and, for users, their tenant id; for
 * admins, their live `tenantScope` and `adminType`, so a scope or type
 * change applies on the next request instead of at token expiry).
 *
 * @param {'user'|'admin'} actorType
 * @param {string} actorId
 * @returns {Promise<{ status: string|null, tenantId: string|null, tenantScope?: string|null, adminType?: string|null }>}
 */
async function accountState(actorType, actorId) {
  return cached(actorType, actorId, async () => {
    const repo = actorType === 'admin' ? adminRepository : userRepository;
    const doc = await safeFind((id) => repo.findById(id), actorId);
    if (!doc || doc.deletedAt) return { status: null, tenantId: null };
    const state = { status: doc.status ?? null, tenantId: doc.tenantId ? String(doc.tenantId) : null };
    if (actorType === 'admin') {
      state.tenantScope = doc.tenantScope ? String(doc.tenantScope) : null;
      state.adminType = doc.adminType ?? null;
    }
    return state;
  });
}

/** Whether a tenant may act right now (cached; same rule as background work). */
async function tenantActive(tenantId) {
  return cached('tenant', tenantId, () => isTenantActive(tenantId, { onLookupError: 'throw' }));
}

function inactive(message, code) {
  const err = ApiError.unauthorized(message);
  err.code = code;
  return err;
}

/**
 * Throw a typed 401 unless the account (and, for users, its tenant) is
 * `active`.
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.actorType
 * @param {string} params.actorId
 * @returns {Promise<{ tenantId: string|null, tenantScope?: string|null, adminType?: string|null }>}
 *   the account's own tenant (users) or live scope and type (admins).
 */
export async function assertActorActive({ actorType, actorId }) {
  const account = await accountState(actorType, actorId);
  if (account.status !== 'active') {
    if (account.status === 'suspended') {
      throw inactive('Account is suspended', ERROR_CODES.ACCOUNT_SUSPENDED);
    }
    throw inactive('Account is not active', ERROR_CODES.ACCOUNT_NOT_ACTIVE);
  }
  if (actorType === 'user') {
    const active = account.tenantId ? await tenantActive(account.tenantId) : false;
    if (!active) {
      throw inactive('Tenant is not active', ERROR_CODES.TENANT_NOT_ACTIVE);
    }
  }
  if (actorType === 'admin') {
    return { tenantId: null, tenantScope: account.tenantScope ?? null, adminType: account.adminType ?? null };
  }
  return { tenantId: account.tenantId };
}

/* --------------------------- change invalidation -------------------------- */

// The repositories above compiled the User / Admin / Tenant models, so their
// audit emitters are registered by now.
for (const { emitter, module } of auditRegistry) {
  const kind = KIND_BY_MODULE[module];
  if (!kind) continue;
  const drop = (event) => {
    const id = event?.doc?._id ?? event?.doc?.id;
    if (id) invalidate(kind, String(id));
  };
  for (const name of ['create', 'update', 'softDelete', 'restore', 'delete']) emitter.on(name, drop);
  // Bulk writes name no single document: forget every cached status.
  for (const name of ['bulkUpdate', 'bulkDelete']) emitter.on(name, () => clear());
}

export default {
  assertActorActive,
  invalidate,
  clear,
  _meta: { cacheTtlMs: TTL_MS },
};
