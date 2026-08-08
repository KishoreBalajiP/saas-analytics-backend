/**
 * Setting Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Business logic for hot-reloadable, typed, scoped settings. Two scopes:
 *   `platform` (source of truth) and `tenant` (per-tenant override).
 *   Onboarding seeds defaults; admins read/update groups; the hot path
 *   reads `resolveEffective` (tenant override wins, cached 60s).
 *
 * RESPONSIBILITY
 *   - list / get / create / update / remove (admin surface)
 *   - resolveEffective(key, { tenantId })   # hot-path reads
 *   - secret redaction + cache invalidation
 *
 * CODING GUIDELINES
 *   - `isSecret` values never leave in plaintext unless the caller opts in
 *     via `includeSecrets` (platform admins); otherwise value is redacted.
 *   - Cache key matches the placeholder contract:
 *     `settings:<scope>:<tenantId|platform>:<key>` (TTL 60s).
 *   - Effective resolution caches the tenant row and the platform row
 *     SEPARATELY so a platform-scoped write only invalidates the platform
 *     key instead of flushing every tenant.
 *   - Writes invalidate the cache for the affected key before returning.
 */

import ApiError from '../utils/ApiError.js';
import * as cache from './cache.service.js';
import * as settingRepository from '../repositories/setting.repository.js';
import { SCOPES, TYPES } from '../models/Setting.js';

const EFFECTIVE_TTL_SECONDS = 60;

/* ------------------------------ cache helpers ------------------------------ */

/** Cache key per the placeholder contract. */
function cacheKey(scope, tenantId, key) {
  const holder = scope === 'platform' ? 'platform' : tenantId;
  return `settings:${scope}:${holder}:${key}`;
}

/* ------------------------------ redaction ------------------------------ */

/**
 * Redact secrets unless the caller is privileged. Returns a new object so
 * the persisted shape is never mutated.
 */
export function redactSetting(setting, includeSecrets) {
  if (!setting) return setting;
  const out = { ...setting };
  if (out.isSecret && !includeSecrets) {
    out.value = null;
    out.redacted = true;
  }
  return out;
}

function assertScope(scope, tenantId) {
  if (!SCOPES.includes(scope)) throw ApiError.badRequest(`Invalid scope "${scope}"`);
  if (scope === 'platform' && tenantId) {
    throw ApiError.badRequest('Platform settings must not carry a tenantId');
  }
  if (scope === 'tenant' && !tenantId) {
    throw ApiError.badRequest('Tenant settings require a tenantId');
  }
}

function assertType(type) {
  if (!TYPES.includes(type)) throw ApiError.badRequest(`Invalid setting type "${type}"`);
}

/* ------------------------------ public API ------------------------------ */

/** List settings in a scope, optionally narrowed by group. */
export const list = async ({ scope, tenantId = null, group, page = 1, limit = 100, includeSecrets = false } = {}) => {
  assertScope(scope, tenantId);
  const result = await settingRepository.list({ scope, tenantId, group, page, limit });
  return {
    ...result,
    docs: result.docs.map((setting) => redactSetting(setting, includeSecrets)),
  };
};

/** Get a single setting by its scoped key. */
export const get = async ({ key, scope, tenantId = null, includeSecrets = false }) => {
  assertScope(scope, tenantId);
  const setting = await settingRepository.findByKey({ key, scope, tenantId });
  if (!setting) throw ApiError.notFound('Setting not found');
  return redactSetting(setting, includeSecrets);
};

/** Create a setting. Returns the saved document. */
export const create = async ({ key, scope, tenantId = null, type, value, description = '', isSecret = false, isReadonly = false, group = 'general', by = null }) => {
  assertScope(scope, tenantId);
  assertType(type);
  const existing = await settingRepository.findByKey({ key, scope, tenantId });
  if (existing) throw ApiError.conflict('Setting already exists');
  const setting = await settingRepository.create({
    key, scope, tenantId, type, value, description, isSecret, isReadonly, group, updatedBy: by,
  });
  await invalidateEffective(scope, tenantId, key);
  return setting;
};

/** Update a setting by id. Returns the updated document. */
export const update = async (id, patch, { by = null, includeSecrets = false } = {}) => {
  const existing = await settingRepository.findById(id);
  if (!existing) throw ApiError.notFound('Setting not found');
  if (existing.isReadonly && patch.value !== undefined) {
    throw ApiError.forbidden('This setting is read-only');
  }
  const safe = { ...patch };
  delete safe.scope;
  delete safe.tenantId;
  if (safe.type !== undefined) assertType(safe.type);
  safe.updatedBy = by ?? existing.updatedBy ?? null;
  const updated = await settingRepository.update(id, safe);
  if (!updated) throw ApiError.notFound('Setting not found');
  await invalidateEffective(existing.scope, existing.tenantId ?? null, existing.key);
  return redactSetting(updated, includeSecrets);
};

/** Soft-delete a setting by id. */
export const remove = async (id, by = null) => {
  const existing = await settingRepository.findById(id);
  if (!existing) throw ApiError.notFound('Setting not found');
  if (existing.isReadonly) throw ApiError.forbidden('This setting is read-only');
  await settingRepository.softDelete(id, by);
  await invalidateEffective(existing.scope, existing.tenantId ?? null, existing.key);
  return { id, deleted: true };
};

/**
 * Hot-path read: the tenant override wins over the platform default.
 * Returns the coerced value or `null` when the key is not configured.
 */
export const resolveEffective = async (key, { tenantId = null } = {}) => {
  if (tenantId) {
    const tenantSetting = await cache.getOrSet(
      cacheKey('tenant', tenantId, key),
      () => settingRepository.findByKey({ key, scope: 'tenant', tenantId }),
      EFFECTIVE_TTL_SECONDS,
    );
    if (tenantSetting) return settingRepository.coerceValue(tenantSetting.type, tenantSetting.value);
  }
  const platformSetting = await cache.getOrSet(
    cacheKey('platform', null, key),
    () => settingRepository.findByKey({ key, scope: 'platform' }),
    EFFECTIVE_TTL_SECONDS,
  );
  if (platformSetting) return settingRepository.coerceValue(platformSetting.type, platformSetting.value);
  return null;
};

/* ------------------------------ internals ------------------------------ */

/**
 * Drop the cached effective value for a (scope, tenantId, key) triple.
 * Exported so sibling services (e.g. tenant settings) can invalidate after a
 * direct write that bypasses this service's create/update/remove.
 */
export async function invalidateEffective(scope, tenantId, key) {
  await cache.del(cacheKey(scope, tenantId, key));
}

export default {
  list,
  get,
  create,
  update,
  remove,
  resolveEffective,
  _meta: { cachedReads: true, cacheKeyPattern: 'settings:<scope>:<tenantId|platform>:<key>' },
};

