/**
 * FeatureFlag Service (Sprint 3; admin surface roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Runtime gating of features, decoupled from deployment. The platform
 *   catalogue is seeded idempotently during tenant onboarding, managed by
 *   platform admins over `/api/v1/feature-flags`, and evaluated per tenant
 *   on the hot path (cached).
 *
 * RESPONSIBILITY
 *   - ensureDefaults                - idempotent platform seed
 *   - listFlags / getFlag           - admin reads
 *   - createFlag / updateFlag /
 *     deleteFlag / rollbackFlag     - versioned admin writes with history
 *                                     and audit
 *   - flagHistory                   - revision history
 *   - resolveForTenant / isEnabled  - rollout evaluation for a tenant
 *   - previewForTenant              - admin view of every flag's outcome
 *   - list / get / getByKey / create / update / remove - legacy helpers
 *     (kept for the tenant settings `feature_flags` group); writes go
 *     through the same versioned path.
 *
 * ROLLOUT EVALUATION (boolean semantics)
 *   - `!enabled`                    -> off everywhere (master switch).
 *   - strategy `all`                -> on for every tenant.
 *   - strategy `tenantId`           -> on only for the allow-listed tenants.
 *   - strategy `percentage`         -> stable hash(flag key, tenantId) % 100
 *                                       < pct: deterministic per tenant and
 *                                       independent between flags.
 *   - strategy `attribute`          -> needs per-user attributes (not
 *                                       supported yet): off, and refused on
 *                                       writes.
 *
 * CODING GUIDELINES
 *   - Cache the ENABLED catalogue under `feature-flag:enabled` (TTL 60s);
 *     every write invalidates it so a stale flag can never leak a wrong
 *     rollout.
 *   - System flags (the seeded defaults) cannot be deleted - disable them
 *     instead - because onboarding re-seeds them by key.
 */

import { createHash } from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import * as cache from './cache.service.js';
import * as featureFlagRepository from '../repositories/featureFlag.repository.js';
import {
  CONFIG_ERROR_CODES,
  versionConflict,
  configError,
  ensureBaseline,
  recordRevision,
  listHistory,
  getRevision,
  auditChange,
} from './configHistory.service.js';

const CATALOGUE_CACHE_KEY = 'feature-flag:enabled';
const CATALOGUE_TTL_SECONDS = 60;
const KIND = 'feature_flag';
const AUDIT_MODULE = 'platform.feature_flags';

/** `<namespace>.<name>` (at least one dot), lowercase. */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
/** Strategies accepted on writes (`attribute` is not evaluable yet). */
export const WRITABLE_STRATEGIES = Object.freeze(['all', 'tenantId', 'percentage']);
export const MAX_ALLOWLIST = 1000;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** Default flags seeded idempotently on first onboarding. */
export const DEFAULT_FLAGS = Object.freeze([
  {
    key: 'analytics.realtime',
    name: 'Realtime analytics',
    description: 'Enables live-updating dashboards and streaming charts.',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'all', tenantIds: [], percentage: 100, attributeRules: [] },
  },
  {
    key: 'analytics.export.csv',
    name: 'CSV export',
    description: 'Enables CSV export on dashboards and reports.',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'all', tenantIds: [], percentage: 100, attributeRules: [] },
  },
  {
    key: 'connectors.webhooks',
    name: 'Webhook connectors',
    description: 'Enables outbound webhook deliveries from connectors.',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'tenantId', tenantIds: [], percentage: 100, attributeRules: [] },
  },
  {
    key: 'compliance.eu_mode',
    name: 'EU compliance mode',
    description: 'Restricts data residency and retention to EU requirements.',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'tenantId', tenantIds: [], percentage: 100, attributeRules: [] },
  },
  // ai-ask: per-tenant rollout of "Ask a question" (allow-list) and the platform kill switch.
  {
    key: 'ai.assistant',
    name: 'AI assistant',
    description: 'Enables natural-language questions for allow-listed workspaces.',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'tenantId', tenantIds: [], percentage: 100, attributeRules: [] },
  },
  {
    key: 'ai.kill_switch',
    name: 'AI kill switch',
    description: 'When enabled, every AI route answers 503 AI_DISABLED.',
    type: 'boolean',
    defaultValue: false,
    enabled: false,
    rollout: { strategy: 'all', tenantIds: [], percentage: 100, attributeRules: [] },
  },
]);

const SYSTEM_FLAG_KEYS = new Set(DEFAULT_FLAGS.map((flag) => flag.key));

/* ------------------------------ evaluation ------------------------------ */

/** Deterministic bucket in [0, 100) for a (flag, tenant) pair. */
export function bucketOf(flagKey, tenantId) {
  const hex = createHash('sha256').update(`${flagKey}:${tenantId}`).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

/**
 * Evaluate one flag for a tenant. Returns `{ value, reason }` where reason
 * is one of `disabled`, `all`, `allow_list`, `not_in_allow_list`,
 * `percentage_in`, `percentage_out`, `unsupported_strategy`, `no_tenant`.
 */
export function explainFlag(flag, tenantId) {
  if (!flag?.enabled) return { value: false, reason: 'disabled' };
  const strategy = flag.rollout?.strategy ?? 'all';
  if (strategy === 'all') return { value: true, reason: 'all' };
  if (!tenantId) return { value: false, reason: 'no_tenant' };
  const id = String(tenantId);
  switch (strategy) {
    case 'tenantId':
      return (flag.rollout?.tenantIds ?? []).map(String).includes(id)
        ? { value: true, reason: 'allow_list' }
        : { value: false, reason: 'not_in_allow_list' };
    case 'percentage':
      return bucketOf(flag.key, id) < (flag.rollout?.percentage ?? 100)
        ? { value: true, reason: 'percentage_in' }
        : { value: false, reason: 'percentage_out' };
    default:
      return { value: false, reason: 'unsupported_strategy' };
  }
}

/** Boolean evaluation of one flag for a tenant. */
export function evaluateFlag(flag, tenantId) {
  return explainFlag(flag, tenantId).value;
}

/* ------------------------------ internals ------------------------------ */

async function invalidateCatalogue() {
  await cache.del(CATALOGUE_CACHE_KEY);
}

function invalidInput(errors) {
  return ApiError.badRequest('Invalid feature flag', errors);
}

/** Managed state recorded in history and audit. */
function stateOf(flag) {
  return {
    name: flag.name,
    description: flag.description ?? '',
    enabled: Boolean(flag.enabled),
    rollout: {
      strategy: flag.rollout?.strategy ?? 'all',
      tenantIds: [...(flag.rollout?.tenantIds ?? [])].map(String),
      percentage: flag.rollout?.percentage ?? 100,
    },
    deleted: Boolean(flag.deletedAt),
  };
}

/** Public admin view of a flag. */
export function presentFlag(flag) {
  if (!flag) return flag;
  return {
    id: String(flag._id),
    key: flag.key,
    name: flag.name,
    description: flag.description ?? '',
    type: flag.type ?? 'boolean',
    enabled: Boolean(flag.enabled),
    rollout: {
      strategy: flag.rollout?.strategy ?? 'all',
      tenantIds: [...(flag.rollout?.tenantIds ?? [])].map(String),
      percentage: flag.rollout?.percentage ?? 100,
    },
    isReadonly: Boolean(flag.isReadonly),
    isSystem: SYSTEM_FLAG_KEYS.has(flag.key),
    version: flag.version ?? 0,
    updatedBy: flag.updatedBy ?? null,
    createdAt: flag.createdAt ?? null,
    updatedAt: flag.updatedAt ?? null,
  };
}

/**
 * Validate a rollout (merged over `base` for partial updates). Collects
 * field errors; `checkTenants` verifies allow-listed tenants exist.
 */
async function normaliseRollout(input, base, errors, { checkTenants = true } = {}) {
  const merged = {
    strategy: base?.strategy ?? 'all',
    tenantIds: [...(base?.tenantIds ?? [])].map(String),
    percentage: base?.percentage ?? 100,
  };
  if (input === undefined) return merged;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ field: 'rollout', message: 'rollout must be an object' });
    return merged;
  }
  if (input.strategy !== undefined) {
    if (!WRITABLE_STRATEGIES.includes(input.strategy)) {
      errors.push({
        field: 'rollout.strategy',
        message: `must be one of: ${WRITABLE_STRATEGIES.join(', ')}`,
      });
    } else {
      merged.strategy = input.strategy;
    }
  }
  if (input.percentage !== undefined) {
    if (!Number.isInteger(input.percentage) || input.percentage < 0 || input.percentage > 100) {
      errors.push({ field: 'rollout.percentage', message: 'must be a whole number between 0 and 100' });
    } else {
      merged.percentage = input.percentage;
    }
  }
  if (input.tenantIds !== undefined) {
    if (!Array.isArray(input.tenantIds)) {
      errors.push({ field: 'rollout.tenantIds', message: 'must be an array of tenant ids' });
    } else if (input.tenantIds.length > MAX_ALLOWLIST) {
      errors.push({ field: 'rollout.tenantIds', message: `must hold at most ${MAX_ALLOWLIST} tenants` });
    } else {
      const ids = [];
      input.tenantIds.forEach((id, index) => {
        if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) {
          errors.push({ field: `rollout.tenantIds[${index}]`, message: 'must be a tenant id' });
        } else if (!ids.includes(id.toLowerCase())) {
          ids.push(id.toLowerCase());
        }
      });
      if (checkTenants && ids.length && errors.length === 0) {
        const known = new Set(await featureFlagRepository.findKnownTenantIds(ids));
        ids.forEach((id) => {
          if (!known.has(id)) {
            errors.push({ field: `rollout.tenantIds[${input.tenantIds.findIndex((x) => String(x).toLowerCase() === id)}]`, message: `tenant ${id} does not exist` });
          }
        });
      }
      merged.tenantIds = ids;
    }
  }
  return merged;
}

function normaliseText(value, field, { required = false, max }, errors) {
  if (value === undefined) {
    if (required) errors.push({ field, message: `${field} is required` });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return undefined;
  }
  const v = value.trim();
  if (required && !v) errors.push({ field, message: `${field} is required` });
  if (v.length > max) errors.push({ field, message: `${field} must be at most ${max} characters` });
  return v;
}

/** Validate a create/update payload into the fields to store. */
async function normaliseInput(input, base, { creating = false, checkTenants = true } = {}) {
  const errors = [];
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput([{ field: 'body', message: 'must be an object' }]);
  }
  if (creating) {
    if (typeof input.key !== 'string' || !FLAG_KEY_PATTERN.test(input.key) || input.key.length > 100) {
      errors.push({
        field: 'key',
        message: 'must look like "namespace.feature" (lowercase letters, digits, underscores; at least one dot)',
      });
    } else {
      out.key = input.key;
    }
  }
  const name = normaliseText(input.name, 'name', { required: creating, max: 120 }, errors);
  if (name !== undefined) out.name = name;
  const description = normaliseText(input.description, 'description', { max: 500 }, errors);
  if (description !== undefined) out.description = description;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'enabled must be true or false' });
    else out.enabled = input.enabled;
  }
  if (input.type !== undefined && input.type !== 'boolean') {
    errors.push({ field: 'type', message: 'only boolean flags are supported' });
  }
  if (input.rollout !== undefined || creating) {
    out.rollout = await normaliseRollout(input.rollout, base?.rollout, errors, { checkTenants });
  }
  if (errors.length) throw invalidInput(errors);
  return out;
}

function actorId(actor) {
  return actor?.id != null ? String(actor.id) : null;
}

/** Load a live flag by key or throw a typed 404. */
async function loadFlag(key) {
  const flag = await featureFlagRepository.findByKey(String(key));
  if (!flag) throw configError(404, CONFIG_ERROR_CODES.FEATURE_FLAG_NOT_FOUND, 'Feature flag not found');
  return flag;
}

/**
 * Versioned change: conditional write, revision, cache invalidation, audit.
 */
async function applyFlagChange({ flag, expectedVersion, set, action, actor, reason = null, rolledBackFrom = null, includeDeleted = false }) {
  const current = flag.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== current) {
    throw versionConflict(current);
  }
  await ensureBaseline({ kind: KIND, resourceKey: flag.key, version: current, state: stateOf(flag) });
  const updated = await featureFlagRepository.updateIfVersion(
    flag._id,
    current,
    { ...set, updatedBy: actorId(actor) },
    { includeDeleted },
  );
  if (!updated) {
    const latest = await featureFlagRepository.findByKeyIncludingDeleted(flag.key);
    throw versionConflict(latest?.version ?? current);
  }
  await recordRevision({
    kind: KIND,
    resourceKey: flag.key,
    version: updated.version,
    action,
    state: stateOf(updated),
    rolledBackFrom,
    reason,
    actor,
  });
  await invalidateCatalogue();
  await auditChange({
    actor,
    action: `feature_flag.${{ create: 'created', update: 'updated', delete: 'deleted', rollback: 'rolled_back' }[action] ?? action}`,
    module: AUDIT_MODULE,
    resource: { type: 'feature_flag', id: flag.key },
    before: { ...stateOf(flag), version: current },
    after: { ...stateOf(updated), version: updated.version, ...(rolledBackFrom != null ? { rolledBackFrom } : {}) },
    reason,
  });
  return updated;
}

/* ------------------------------ admin API ------------------------------ */

/** Paginated admin listing. */
export async function listFlags({ search, enabled, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (typeof enabled === 'boolean') filter.enabled = enabled;
  if (search) filter.search = search;
  const result = await featureFlagRepository.list({ filter, page, limit });
  return { ...result, docs: result.docs.map(presentFlag) };
}

/** One flag by key. */
export async function getFlag(key) {
  return presentFlag(await loadFlag(key));
}

/**
 * Create a flag (boolean). Re-creating a previously deleted key revives it
 * with the new definition and continues its history.
 */
export async function createFlag({ data, actor, reason = null }) {
  const input = await normaliseInput(data, null, { creating: true });
  const existing = await featureFlagRepository.findByKeyIncludingDeleted(input.key);
  if (existing && !existing.deletedAt) {
    throw configError(409, CONFIG_ERROR_CODES.FEATURE_FLAG_EXISTS, `Feature flag "${input.key}" already exists`);
  }
  const fields = {
    name: input.name,
    description: input.description ?? '',
    type: 'boolean',
    defaultValue: false,
    enabled: input.enabled ?? false,
    rollout: { ...input.rollout, attributeRules: [] },
  };
  let flag;
  if (existing) {
    flag = await applyFlagChange({
      flag: existing,
      set: { ...fields, deletedAt: null, deletedBy: null },
      action: 'create',
      actor,
      reason,
      includeDeleted: true,
    });
  } else {
    let created;
    try {
      created = await featureFlagRepository.create({ key: input.key, ...fields, version: 1, updatedBy: actorId(actor) });
    } catch (error) {
      if (error?.code === 11000) {
        throw configError(409, CONFIG_ERROR_CODES.FEATURE_FLAG_EXISTS, `Feature flag "${input.key}" already exists`);
      }
      throw error;
    }
    await recordRevision({
      kind: KIND, resourceKey: created.key, version: 1, action: 'create', state: stateOf(created), reason, actor,
    });
    await invalidateCatalogue();
    await auditChange({
      actor,
      action: 'feature_flag.created',
      module: AUDIT_MODULE,
      resource: { type: 'feature_flag', id: created.key },
      after: { ...stateOf(created), version: 1 },
      reason,
    });
    flag = created;
  }
  return presentFlag(flag);
}

/** Update name / description / enabled / rollout (partial; rollout merges). */
export async function updateFlag({ key, patch, version, actor, reason = null }) {
  const flag = await loadFlag(key);
  if (flag.isReadonly && (patch?.enabled !== undefined || patch?.rollout !== undefined)) {
    throw configError(403, CONFIG_ERROR_CODES.FEATURE_FLAG_READ_ONLY, 'This flag is read-only');
  }
  const input = await normaliseInput(patch, flag);
  if (Object.keys(input).length === 0) {
    throw invalidInput([{ field: 'body', message: 'provide at least one of name, description, enabled, rollout' }]);
  }
  if (input.rollout) input.rollout = { ...input.rollout, attributeRules: flag.rollout?.attributeRules ?? [] };
  const updated = await applyFlagChange({ flag, expectedVersion: version, set: input, action: 'update', actor, reason });
  return presentFlag(updated);
}

/** Soft-delete a non-system flag (it then evaluates to off everywhere). */
export async function deleteFlag({ key, version, actor, reason = null }) {
  const flag = await loadFlag(key);
  if (SYSTEM_FLAG_KEYS.has(flag.key)) {
    throw configError(
      409,
      CONFIG_ERROR_CODES.FEATURE_FLAG_SYSTEM,
      'System flags cannot be deleted. Disable the flag instead.',
    );
  }
  const updated = await applyFlagChange({
    flag,
    expectedVersion: version,
    set: { deletedAt: new Date(), deletedBy: actorId(actor) },
    action: 'delete',
    actor,
    reason,
  });
  return { key: updated.key, deleted: true, version: updated.version };
}

/** Revision history for a flag (live or deleted). */
export async function flagHistory({ key, page = 1, limit = 20 }) {
  const flag = await featureFlagRepository.findByKeyIncludingDeleted(String(key));
  if (!flag) throw configError(404, CONFIG_ERROR_CODES.FEATURE_FLAG_NOT_FOUND, 'Feature flag not found');
  return listHistory({ kind: KIND, resourceKey: flag.key, page, limit });
}

/**
 * Restore the exact state of an earlier version (name, description,
 * enabled, rollout). Rolling back a deleted flag to a live version revives
 * it; rolling back TO a deleted version is refused (use delete).
 */
export async function rollbackFlag({ key, toVersion, version, actor, reason = null }) {
  const flag = await featureFlagRepository.findByKeyIncludingDeleted(String(key));
  if (!flag) throw configError(404, CONFIG_ERROR_CODES.FEATURE_FLAG_NOT_FOUND, 'Feature flag not found');
  const target = await getRevision({ kind: KIND, resourceKey: flag.key, version: toVersion });
  const state = target.state ?? {};
  if (state.deleted) {
    throw ApiError.badRequest('Cannot roll back to a deleted version', [
      { field: 'toVersion', message: 'that version is a deletion; delete the flag instead' },
    ]);
  }
  if (flag.isReadonly) {
    throw configError(403, CONFIG_ERROR_CODES.FEATURE_FLAG_READ_ONLY, 'This flag is read-only');
  }
  const errors = [];
  // Exact restore: shape-check only (an allow-listed tenant may since have been removed).
  const rollout = await normaliseRollout(state.rollout ?? {}, {}, errors, { checkTenants: false });
  if (errors.length) throw invalidInput(errors);
  const updated = await applyFlagChange({
    flag,
    expectedVersion: version,
    set: {
      name: state.name ?? flag.name,
      description: state.description ?? '',
      enabled: Boolean(state.enabled),
      rollout: { ...rollout, attributeRules: flag.rollout?.attributeRules ?? [] },
      deletedAt: null,
      deletedBy: null,
    },
    action: 'rollback',
    actor,
    reason,
    rolledBackFrom: toVersion,
    includeDeleted: true,
  });
  return presentFlag(updated);
}

/**
 * Admin preview: every flag's outcome for one tenant, with the reason.
 * Throws 404 when the tenant does not exist.
 */
export async function previewForTenant(tenantId) {
  const id = String(tenantId ?? '');
  if (!OBJECT_ID_RE.test(id) || (await featureFlagRepository.findKnownTenantIds([id])).length === 0) {
    throw ApiError.notFound('Tenant not found');
  }
  const flags = await featureFlagRepository.findAll();
  return flags.map((flag) => ({ key: flag.key, name: flag.name, ...explainFlag(flag, id) }));
}

/* ------------------------------ public API ------------------------------ */

/** Idempotently seed the platform flag catalogue. */
export const ensureDefaults = async ({ by = 'system' } = {}) => {
  for (const flag of DEFAULT_FLAGS) {
    const existing = await featureFlagRepository.findByKeyIncludingDeleted(flag.key);
    if (existing) continue;
    try {
      await featureFlagRepository.create({ ...flag, updatedBy: by });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const createdByConcurrentInitializer = await featureFlagRepository.findByKeyIncludingDeleted(flag.key);
      if (!createdByConcurrentInitializer) throw error;
    }
  }
  await invalidateCatalogue();
  return { seeded: true };
};

/** Paginated catalogue listing (raw documents). */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) =>
  featureFlagRepository.list({ filter, page, limit });

/** Get a single flag by id. */
export const get = async (id) => {
  const flag = await featureFlagRepository.findById(id);
  if (!flag) throw ApiError.notFound('Feature flag not found');
  return flag;
};

/** Get a single flag by its unique key. */
export const getByKey = async (key) => {
  const flag = await featureFlagRepository.findByKey(key);
  if (!flag) throw ApiError.notFound('Feature flag not found');
  return flag;
};

/** Create a flag (legacy signature). Returns the saved document. */
export const create = async (data, by = null) => {
  const created = await createFlag({ data, actor: by ? { type: 'admin', id: by } : null });
  return featureFlagRepository.findByKey(created.key);
};

/**
 * Update a flag by id (legacy signature, used by the tenant settings
 * `feature_flags` group). Goes through the versioned, audited path.
 */
export const update = async (id, patch, by = null) => {
  const existing = await featureFlagRepository.findById(id);
  if (!existing) throw ApiError.notFound('Feature flag not found');
  const clean = { ...patch };
  if (clean.rollout) {
    const { strategy, tenantIds, percentage } = clean.rollout;
    clean.rollout = { strategy, tenantIds, percentage };
    Object.keys(clean.rollout).forEach((k) => clean.rollout[k] === undefined && delete clean.rollout[k]);
  }
  delete clean.updatedBy;
  await updateFlag({ key: existing.key, patch: clean, actor: by ? { type: 'admin', id: by } : null });
  return featureFlagRepository.findByKey(existing.key);
};

/** Soft-delete a flag by id (legacy signature). */
export const remove = async (id, by = null) => {
  const existing = await featureFlagRepository.findById(id);
  if (!existing) throw ApiError.notFound('Feature flag not found');
  await deleteFlag({ key: existing.key, actor: by ? { type: 'admin', id: by } : null });
  return { id, deleted: true };
};

/**
 * Resolve the effective value of every enabled flag for a tenant.
 * Returns `{ [key]: boolean }`; disabled or deleted flags are absent
 * (callers treat a missing key as off).
 */
export const resolveForTenant = async (tenantId) => {
  const flags = await cache.getOrSet(
    CATALOGUE_CACHE_KEY,
    () => featureFlagRepository.findEnabled(),
    CATALOGUE_TTL_SECONDS,
  );
  const out = {};
  for (const flag of flags) {
    out[flag.key] = evaluateFlag(flag, tenantId);
  }
  return out;
};

/**
 * Workspace settings view: expose the server's evaluated value and the
 * reason without exposing rollout allow-lists or other platform details.
 */
export async function explainForTenant(tenantId) {
  const flags = await featureFlagRepository.findAll();
  return flags.map((flag) => {
    const outcome = explainFlag(flag, tenantId);
    return {
      key: flag.key,
      name: flag.name,
      description: flag.description ?? '',
      value: outcome.value,
      reason: outcome.reason,
    };
  });
}

/** Whether one flag is on for a tenant (missing / disabled -> false). */
export async function isEnabled(key, { tenantId } = {}) {
  const flags = await resolveForTenant(tenantId);
  return flags[key] === true;
}

export default {
  ensureDefaults,
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  deleteFlag,
  flagHistory,
  rollbackFlag,
  previewForTenant,
  list,
  get,
  getByKey,
  create,
  update,
  remove,
  resolveForTenant,
  isEnabled,
  evaluateFlag,
  explainForTenant,
  explainFlag,
  _meta: { cachedReads: true, cacheKeyPattern: 'feature-flag:enabled' },
};
