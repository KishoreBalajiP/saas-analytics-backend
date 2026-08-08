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
 * FAILURE MODEL
 *   The cache is an accelerator, never an authorisation oracle. If a cache
 *   op throws (`CacheError`), callers must fall back to the live DB
 *   resolution - which is exactly what `resolve()` does.
 */

import cache from './cache.service.js';

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

/**
 * Resolve `fn` and cache the result for 60s under the versioned actor key.
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
  const key = actorKey({ scope, scopeVersion, globalVersion, kind, actorType, actorId });
  try {
    return await cache.getOrSet(key, fn, RBAC_CACHE_TTL_SEC);
  } catch {
    return fn();
  }
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
