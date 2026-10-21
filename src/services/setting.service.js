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
 *   - `isSecret` values are encrypted at rest (`secret` holds the AES-GCM
 *     envelope from `utils/encryption.js`; the plaintext `value` stays
 *     empty). They never leave in plaintext unless the caller opts in via
 *     `includeSecrets` / `presentSetting` after a `settings.secrets.view`
 *     check; otherwise the value is redacted. The envelope itself is never
 *     returned to any caller.
 *   - Cache key matches the placeholder contract:
 *     `settings:<scope>:<tenantId|platform>:<key>` (TTL 60s).
 *   - Effective resolution caches the tenant row and the platform row
 *     SEPARATELY so a platform-scoped write only invalidates the platform
 *     key instead of flushing every tenant.
 *   - Writes invalidate the cache for the affected key before returning.
 */

import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/encryption.js';
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

/* --------------------------- secret storage ---------------------------- */

/** Key-derivation context binding a secret to its exact (scope, tenant, key). */
function secretContext({ scope, tenantId = null, key }) {
  return { purpose: 'setting', scope, tenant: tenantId ? String(tenantId) : 'platform', key };
}

/**
 * Encrypt a secret value for storage. An empty value means "not set" and is
 * stored as no envelope at all. Returns the envelope string or null.
 */
export async function sealSecretValue({ scope, tenantId = null, key, value }) {
  if (value === null || value === undefined || value === '') return null;
  return encrypt(String(value), secretContext({ scope, tenantId, key }));
}

/**
 * Decrypt a stored secret row back to its plaintext (memory only). Rows
 * written before encryption at rest carry the plaintext in `value`; they
 * are returned as-is until `encryptLegacySecrets` migrates them.
 */
export async function openSecretValue(setting) {
  if (!setting) return '';
  if (setting.secret) {
    return decrypt(setting.secret, secretContext({
      scope: setting.scope, tenantId: setting.tenantId ?? null, key: setting.key,
    }));
  }
  return setting.value == null ? '' : String(setting.value);
}

/** Whether a secret row holds a non-empty value (without decrypting it). */
export function secretHasValue(setting) {
  return Boolean(setting?.secret) || (setting?.value != null && setting.value !== '');
}

/* ------------------------------ redaction ------------------------------ */

/**
 * Redact secrets unless the caller is privileged. Returns a new object so
 * the persisted shape is never mutated. The encrypted envelope is always
 * stripped; use `presentSetting` to return a decrypted secret.
 */
export function redactSetting(setting, includeSecrets) {
  if (!setting) return setting;
  const out = { ...setting };
  delete out.secret;
  if (out.isSecret && !includeSecrets) {
    out.value = null;
    out.redacted = true;
    out.hasValue = secretHasValue(setting);
  }
  return out;
}

/**
 * Public view of a setting row: secrets are masked, or decrypted when the
 * caller has been authorised to read them (`includeSecrets`).
 */
export async function presentSetting(setting, { includeSecrets = false } = {}) {
  if (!setting) return setting;
  if (!setting.isSecret || !includeSecrets) return redactSetting(setting, false);
  const out = redactSetting(setting, true);
  out.value = await openSecretValue(setting);
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
    docs: await Promise.all(result.docs.map((setting) => presentSetting(setting, { includeSecrets }))),
  };
};

/** Get a single setting by its scoped key. */
export const get = async ({ key, scope, tenantId = null, includeSecrets = false }) => {
  assertScope(scope, tenantId);
  const setting = await settingRepository.findByKey({ key, scope, tenantId });
  if (!setting) throw ApiError.notFound('Setting not found');
  return presentSetting(setting, { includeSecrets });
};

/** Create a setting. Returns the saved document. */
export const create = async ({ key, scope, tenantId = null, type, value, description = '', isSecret = false, isReadonly = false, group = 'general', by = null }) => {
  assertScope(scope, tenantId);
  assertType(type);
  const existing = await settingRepository.findByKey({ key, scope, tenantId });
  if (existing) throw ApiError.conflict('Setting already exists');
  const secret = isSecret ? await sealSecretValue({ scope, tenantId, key, value }) : null;
  const setting = await settingRepository.create({
    key, scope, tenantId, type, value: isSecret ? '' : value, secret, description, isSecret, isReadonly, group, updatedBy: by,
  });
  await invalidateEffective(scope, tenantId, key);
  return redactSetting(setting, false);
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
  delete safe.secret;
  if (safe.type !== undefined) assertType(safe.type);
  const secretRow = safe.isSecret ?? existing.isSecret;
  if (secretRow && safe.value !== undefined) {
    safe.secret = await sealSecretValue({
      scope: existing.scope, tenantId: existing.tenantId ?? null, key: existing.key, value: safe.value,
    });
    safe.value = '';
  }
  safe.updatedBy = by ?? existing.updatedBy ?? null;
  const updated = await settingRepository.update(id, safe);
  if (!updated) throw ApiError.notFound('Setting not found');
  await invalidateEffective(existing.scope, existing.tenantId ?? null, existing.key);
  return presentSetting(updated, { includeSecrets });
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
    if (tenantSetting) return effectiveValue(tenantSetting);
  }
  const platformSetting = await cache.getOrSet(
    cacheKey('platform', null, key),
    () => settingRepository.findByKey({ key, scope: 'platform' }),
    EFFECTIVE_TTL_SECONDS,
  );
  if (platformSetting) return effectiveValue(platformSetting);
  return null;
};

/** Coerced hot-path value of a row; secrets are decrypted in memory. */
async function effectiveValue(setting) {
  if (setting.isSecret) return openSecretValue(setting);
  return settingRepository.coerceValue(setting.type, setting.value);
}

/**
 * One-off migration: encrypt secret rows that still hold a plaintext value
 * (written before encryption at rest). Dry run by default.
 *
 * @returns {Promise<{ candidates: number, encrypted: number, dryRun: boolean }>}
 */
export const encryptLegacySecrets = async ({ dryRun = true } = {}) => {
  const rows = await settingRepository.findLegacyPlaintextSecrets();
  let encrypted = 0;
  if (!dryRun) {
    for (const row of rows) {
      const secret = await sealSecretValue({
        scope: row.scope, tenantId: row.tenantId ?? null, key: row.key, value: row.value,
      });
      await settingRepository.replaceSecretPlaintext(row._id, secret);
      await invalidateEffective(row.scope, row.tenantId ?? null, row.key);
      encrypted += 1;
    }
  }
  return { candidates: rows.length, encrypted, dryRun };
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
  redactSetting,
  presentSetting,
  sealSecretValue,
  openSecretValue,
  encryptLegacySecrets,
  _meta: { cachedReads: true, cacheKeyPattern: 'settings:<scope>:<tenantId|platform>:<key>' },
};

