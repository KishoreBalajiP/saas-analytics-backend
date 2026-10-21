/**
 * RBAC Cache Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Versioned caching for the actor-permission hot path plus the
 *   invalidation surface every RBAC mutation must call. This is the ONLY
 *   module allowed to know how the `iam:rbac:*` keys are shaped.
 *
 * WHY VERSIONED
 *   The cache drivers (memory/Redis) expose no prefix/pattern delete, so
 *   "invalidate the whole scope" cannot be a `del('iam:rbac:*')`. Instead
 *   every actor entry embeds two monotonically increasing versions:
 *
 *     key = iam:rbac:<scope>:<scopeVersion>:<globalVersion>:<kind>:<actorType>:<actorId>
 *
 *   - kind separates what is cached under the actor key: `perms` (the
 *     effective permission set) vs `roles` (the role-name set). Both share
 *     the version counters, so a role/permission mutation invalidates both.
 *   - scopeVersion bumps when a role/assignment changes INSIDE one scope,
 *     so only that tenant (or platform) sees a fresh resolution.
 *   - globalVersion bumps when a module/permission row changes, because a
 *     new permission key is potentially relevant to every scope.
 *
 *   A mutation therefore invalidates by incrementing a counter (atomic on
 *   both drivers) instead of enumerating keys; stale entries simply expire
 *   on their 60s TTL and are never read again.
 *
 *   A tenant-scoped admin's effective set is its platform grants plus its
 *   grants for that tenant, so its entry embeds BOTH the tenant scope
 *   version and the platform scope version: a change to either (e.g. a
 *   platform role's permissions) invalidates it.
 *
 * EXPIRY BOUND
 *   Role grants can be temporary (`expiresAt`). A cached set must never
 *   outlive the earliest live grant it was built from, so on every miss the
 *   earliest expiry is read FIRST (any grant the resolver then sees was live
 *   at that moment, so its own expiry is no earlier), and the entry is
 *   stored as `{ v, exp }` with a TTL of at most the time left until `exp`.
 *   Reads also re-check `exp`, because cache TTLs have one-second
 *   granularity. An expired grant therefore stops working at its deadline
 *   even while the actor's set is cached.
 *
 * FAILURE MODEL
 *   The cache is an accelerator, never an authorisation oracle. If a cache
 *   op throws (`CacheError`), callers must fall back to the live DB
 *   resolution - which is exactly what `resolve()` does.
 */

import cache from './cache.service.js';
import roleGrantRepository from '../repositories/roleGrant.repository.js';

/** How long a resolved permission set is trusted (seconds). */
export const RBAC_CACHE_TTL_SEC = 60;

/** Scope label for platform-level (null tenant) grants. */
export const PLATFORM_SCOPE = 'platform';

const GLOBAL_VERSION_KEY = 'rbac:ver:global';
const scopeVersionKey = (scope) => `rbac:ver:${scope}`;
const actorKey = ({ scope, scopeVersion, globalVersion, kind, actorType, actorId }) =>
  `rbac:${scope}:${scopeVersion}:${globalVersion}:${kind}:${actorType}:${actorId}`;

/**
 * Resolve `scope` to a cache label. `tenantId === null` becomes the
 * platform scope; any other value is used verbatim.
 *
 * @param {string|null|undefined} tenantId
 * @returns {string}
 */
export function scopeLabel(tenantId) {
  return tenantId ?? PLATFORM_SCOPE;
}

/**
 * Read the current global + scope versions, defaulting to `0` when the
 * cache is empty or unavailable. Never throws.
 *
 * @param {string} scope
 * @returns {Promise<{ globalVersion: number, scopeVersion: number }>}
 */
async function currentVersions(scope) {
  try {
    const [globalVersion, scopeVersion] = await Promise.all([
      cache.get(GLOBAL_VERSION_KEY),
      cache.get(scopeVersionKey(scope)),
    ]);
    return {
      globalVersion: Number(globalVersion) || 0,
      scopeVersion: Number(scopeVersion) || 0,
    };
  } catch {
    return { globalVersion: 0, scopeVersion: 0 };
  }
}

/** A cached entry is `{ v: value, exp: epochMs|null }`. */
function isEnvelope(entry) {
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && 'v' in entry;
}

/**
 * Resolve `fn` and cache the result under the versioned actor key for at
 * most 60s, and never past the earliest expiry of the actor's live grants.
 * Cache failures degrade to a live resolution (fail-open accelerator).
 *
 * @param {Object} opts
 * @param {string|null} opts.tenantId - actor's scope; null => platform.
 * @param {'admin'|'user'} opts.actorType
 * @param {string} opts.actorId
 * @param {() => Promise<any>} opts.fn - live resolution used on miss/failure.
 * @param {'perms'|'roles'} [opts.kind='perms'] - what is cached under the key.
 * @returns {Promise<any>}
 */
export async function resolve({ tenantId, actorType, actorId, fn, kind = 'perms' }) {
  const scope = scopeLabel(tenantId);
  const { globalVersion, scopeVersion } = await currentVersions(scope);
  // Scoped admins also depend on their platform grants (see WHY VERSIONED).
  const dependsOnPlatform = actorType === 'admin' && scope !== PLATFORM_SCOPE;
  const platformVersion = dependsOnPlatform
    ? (await currentVersions(PLATFORM_SCOPE)).scopeVersion
    : null;
  const key = actorKey({
    scope,
    scopeVersion: dependsOnPlatform ? `${scopeVersion}.${platformVersion}` : scopeVersion,
    globalVersion,
    kind,
    actorType,
    actorId,
  });

  let hit = null;
  try {
    hit = await cache.get(key);
  } catch {
    return fn();
  }
  if (isEnvelope(hit) && (hit.exp === null || hit.exp === undefined || hit.exp > Date.now())) {
    return hit.v;
  }

  // Earliest live grant expiry FIRST, then the resolution (see EXPIRY BOUND).
  const expiry = await roleGrantRepository.findEarliestGrantExpiry({
    actorType,
    actorId,
    tenantId: tenantId ?? null,
  });
  const value = await fn();
  const exp = expiry ? expiry.getTime() : null;
  const ttlSec = exp === null
    ? RBAC_CACHE_TTL_SEC
    : Math.min(RBAC_CACHE_TTL_SEC, Math.floor((exp - Date.now()) / 1000));
  if (ttlSec >= 1 && value !== null && value !== undefined) {
    try {
      await cache.set(key, { v: value, exp }, ttlSec);
    } catch {
      /* accelerator only */
    }
  }
  return value;
}

/**
 * Invalidate every cached permission set inside ONE scope. Called after
 * role/permission-membership/assignment mutations for that scope.
 *
 * @param {string|null} tenantId
 * @returns {Promise<void>}
 */
export async function invalidateScope(tenantId) {
  try {
    await cache.increment(scopeVersionKey(scopeLabel(tenantId)));
  } catch (err) {
    // Swallow: a stale 60s cache is acceptable; a failed invalidation must
    // never break the mutation that triggered it.
    /* eslint-disable-next-line no-console */
    console.error('[rbac-cache] scope invalidation failed', err?.message);
  }
}

/**
 * Invalidate EVERY cached permission set. Called after module/permission
 * rows change, since new permission keys may matter to any scope.
 *
 * @returns {Promise<void>}
 */
export async function invalidateAll() {
  try {
    await cache.increment(GLOBAL_VERSION_KEY);
  } catch (err) {
    /* eslint-disable-next-line no-console */
    console.error('[rbac-cache] global invalidation failed', err?.message);
  }
}

/** Drop the whole RBAC cache (tests, or a hard reset). */
export async function clearAll() {
  await cache.flushAll();
}

export default {
  RBAC_CACHE_TTL_SEC,
  PLATFORM_SCOPE,
  scopeLabel,
  resolve,
  invalidateScope,
  invalidateAll,
  clearAll,
};
