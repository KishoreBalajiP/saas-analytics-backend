/**
 * FeatureFlag Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Runtime gating of features, decoupled from deployment. The platform
 *   catalogue is seeded idempotently during tenant onboarding; resolution
 *   runs on the hot path and is cached.
 *
 * RESPONSIBILITY
 *   - ensureDefaults - idempotent platform seed
 *   - list / get / create / update / remove  (admin surface)
 *   - resolveForTenant - rollout evaluation for a tenant
 *
 * ROLLOUT EVALUATION (boolean semantics)
 *   - `!enabled`                    -> off everywhere (master switch).
 *   - strategy `all`                -> on for every tenant.
 *   - strategy `tenantId`           -> on only for the allowlisted tenants.
 *   - strategy `percentage`         -> stable hash(tenantId) % 100 < pct,
 *                                       deterministic across requests.
 *   - strategy `attribute`          -> requires per-user attributes (Sprint
 *                                       5); without a user context the flag
 *                                       is off.
 *
 * CODING GUIDELINES
 *   - Cache the ENABLED catalogue under `feature-flag:enabled` (TTL 60s);
 *     every write invalidates it so a stale flag can never leak a wrong
 *     rollout.
 *   - Resolution only reads; writes go through the repository and always
 *     invalidate before returning.
 */

import { createHash } from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import * as cache from './cache.service.js';
import * as featureFlagRepository from '../repositories/featureFlag.repository.js';
import { ROLLOUT_STRATEGIES } from '../models/FeatureFlag.js';

const CATALOGUE_CACHE_KEY = 'feature-flag:enabled';
const CATALOGUE_TTL_SECONDS = 60;

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
]);

/* ------------------------------ cache helpers ------------------------------ */

function assertRollout(rollout) {
  if (!rollout) return;
  if (rollout.strategy !== undefined && !ROLLOUT_STRATEGIES.includes(rollout.strategy)) {
    throw ApiError.badRequest(`Invalid rollout strategy "${rollout.strategy}"`);
  }
  const pct = rollout.percentage;
  if (pct !== undefined && (typeof pct !== 'number' || pct < 0 || pct > 100)) {
    throw ApiError.badRequest('Rollout percentage must be between 0 and 100');
  }
}

/** Deterministic tenant bucket in [0, 100). */
function bucketOf(tenantId) {
  const hex = createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

/** Evaluate whether a single flag is on for a tenant. */
function evaluateFlag(flag, tenantId) {
  if (!flag.enabled) return false;
  switch (flag.rollout?.strategy ?? 'all') {
    case 'all':
      return true;
    case 'tenantId':
      return (flag.rollout.tenantIds ?? []).includes(tenantId);
    case 'percentage':
      return bucketOf(tenantId) < (flag.rollout.percentage ?? 100);
    case 'attribute':
      return false;
    default:
      return false;
  }
}

/* ------------------------------ public API ------------------------------ */

/** Idempotently seed the platform flag catalogue. */
export const ensureDefaults = async ({ by = 'system' } = {}) => {
  for (const flag of DEFAULT_FLAGS) {
    const existing = await featureFlagRepository.findByKey(flag.key);
    if (existing) continue;
    await featureFlagRepository.create({ ...flag, updatedBy: by });
  }
  await invalidateCatalogue();
  return { seeded: true };
};

/** Paginated catalogue listing. */
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

/** Create a flag. Returns the saved document. */
export const create = async (data, by = null) => {
  assertRollout(data.rollout);
  const existing = await featureFlagRepository.findByKey(data.key);
  if (existing) throw ApiError.conflict('Feature flag key already exists');
  const flag = await featureFlagRepository.create({ ...data, updatedBy: by });
  await invalidateCatalogue();
  return flag;
};

/** Update a flag by id. Returns the updated document. */
export const update = async (id, patch, by = null) => {
  const existing = await featureFlagRepository.findById(id);
  if (!existing) throw ApiError.notFound('Feature flag not found');
  if (existing.isReadonly && (patch.enabled !== undefined || patch.rollout !== undefined)) {
    throw ApiError.forbidden('This flag is read-only');
  }
  assertRollout(patch.rollout);
  const updated = await featureFlagRepository.update(id, { ...patch, updatedBy: by });
  await invalidateCatalogue();
  return updated;
};

/** Soft-delete a flag by id. */
export const remove = async (id, by = null) => {
  const existing = await featureFlagRepository.findById(id);
  if (!existing) throw ApiError.notFound('Feature flag not found');
  await featureFlagRepository.softDelete(id, by);
  await invalidateCatalogue();
  return { id, deleted: true };
};

/**
 * Resolve the effective value of every enabled flag for a tenant.
 * Returns `{ [key]: boolean }`.
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

/* ------------------------------ internals ------------------------------ */

async function invalidateCatalogue() {
  await cache.del(CATALOGUE_CACHE_KEY);
}

export default {
  ensureDefaults,
  list,
  get,
  getByKey,
  create,
  update,
  remove,
  resolveForTenant,
  _meta: { cachedReads: true, cacheKeyPattern: 'feature-flag:enabled' },
};
