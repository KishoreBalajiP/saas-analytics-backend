/**
 * Usage counter repository (Phase 6 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the per-tenant, per-metric, per-period counter
 *   that backs quota enforcement. All write methods use atomic
 *   `findOneAndUpdate + $inc + upsert` so concurrent calls cannot
 *   exceed a hard limit by more than a single document.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findOne(tenantId, metric, period)
 *   - getUsage(tenantId, period='current')
 *   - incrementOrCreate({ tenantId, metric, period, delta, by })
 *   - setToActual({ tenantId, metric, period, value, by })     reconciliation
 *   - getUsageMap(tenantId, period)                            batched read
 *
 * CODING GUIDELINES
 *   - `tenantId` is the partition key; the unique compound index makes
 *     upserts safe.
 *   - `incrementOrCreate` ALWAYS upserts and is the ONLY way to bump a
 *     counter. The service layer never reads-then-writes; that would
 *     reintroduce the check-then-write race this method exists to fix.
 *   - The `delta` argument is signed; negative deltas decrement (used
 *     by soft-delete handlers).
 *   - `setToActual` is the reconciliation path; the service layer
 *     enforces the period key.
 */

import { UsageCounter, USAGE_METRICS } from '../models/UsageCounter.js';

function safeId(id) {
  return typeof id === 'string' ? id : id ? String(id) : null;
}

export const findOne = async (tenantId, metric, period = 'current') => {
  if (!tenantId || !metric) return null;
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  return UsageCounter.findOne({
    tenantId: safeId(tenantId),
    metric,
    period,
  }).lean();
};

/** Return all current-state counters for a tenant as `{ metric: value }`. */
export const getUsage = async (tenantId, period = 'current') => {
  if (!tenantId) return {};
  const docs = await UsageCounter.find({ tenantId: safeId(tenantId), period })
    .select({ metric: 1, value: 1, kind: 1, lastReconciledAt: 1 })
    .lean();
  const map = {};
  for (const doc of docs) map[doc.metric] = doc.value;
  return map;
};

export const getUsageMap = async (tenantId, period = 'current') => {
  const map = await getUsage(tenantId, period);
  // Provide explicit zeros for known metrics so callers can render the
  // full grid even when no counter row exists yet.
  const result = {};
  for (const metric of USAGE_METRICS) result[metric] = map[metric] ?? 0;
  return result;
};

/**
 * Atomically increment (or create) a counter. This is the ONLY path
 * the service layer uses to bump a counter. The unique compound index
 * makes the upsert safe under concurrent calls; the function never
 * reads-then-writes.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.metric
 * @param {string} [opts.period='current']
 * @param {number} [opts.delta=1]
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ value: number, created: boolean }>}
 */
export const incrementOrCreate = async ({
  tenantId,
  metric,
  period = 'current',
  delta = 1,
  by = null,
  kind = 'current',
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('delta must be a non-zero finite number');
  }
  const filter = {
    tenantId: safeId(tenantId),
    metric,
    period,
  };
  const update = {
    $inc: { value: delta },
    $set: { lastIncrementedAt: new Date(), updatedBy: by, kind },
  };
  const options = { new: true, upsert: true, setDefaultsOnInsert: true, lean: true, runValidators: true };
  const doc = await UsageCounter.findOneAndUpdate(filter, update, options);
  // The "created" flag is approximated: a row whose `value` equals
  // the absolute value of `delta` was just created.
  const created = doc.value === Math.abs(delta);
  return { value: doc.value, created, doc };
};

/**
 * Reconciliation path: set the counter to an authoritative value.
 * Only used by the background reconciliation job. NOT on the hot path.
 */
export const setToActual = async ({
  tenantId,
  metric,
  period = 'current',
  value,
  by = null,
  kind = 'current',
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('value must be a non-negative finite number');
  }
  const filter = {
    tenantId: safeId(tenantId),
    metric,
    period,
  };
  const update = {
    $set: {
      value,
      lastReconciledAt: new Date(),
      updatedBy: by,
      kind,
    },
  };
  const options = { new: true, upsert: true, setDefaultsOnInsert: true, lean: true, runValidators: true };
  return UsageCounter.findOneAndUpdate(filter, update, options);
};

export const list = async ({ page = 1, limit = 50, filter = {} } = {}) => {
  const result = await UsageCounter.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { updatedAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

export default {
  findOne,
  getUsage,
  getUsageMap,
  incrementOrCreate,
  setToActual,
  list,
  _meta: { tenancy: 'tenant', unique: ['tenantId', 'metric', 'period'] },
};
