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
 *   - incrementWithinLimit({ tenantId, metric, period, delta, max })
 *                                          atomic check-and-increment
 *   - decrementClamped({ tenantId, metric, period, delta })  never below 0
 *   - compareAndSet({ tenantId, metric, expected, value })   reconciliation
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

/** Fields a counter row gets when an upsert creates it. */
function insertDefaults({ kind, expiresAt }) {
  const now = new Date();
  return {
    kind,
    lastReconciledAt: null,
    expiresAt: expiresAt ?? null,
    createdAt: now,
    __v: 0,
  };
}

/**
 * Atomic check-and-increment: add `delta` only while the stored value is at
 * most `max - delta`, so concurrent callers can never push the counter past
 * `max`. A row that does not exist yet is created with `value = delta`.
 *
 * When the row exists but has no room, the conditional filter does not
 * match, the upsert tries to insert a second row for the same key and the
 * unique index rejects it (E11000): that is the "limit reached" signal.
 * A duplicate key can also come from two callers creating the first row at
 * the same time, so the call re-checks and retries while there is room.
 *
 * `silent: true` writes through the native driver so hot-path metering
 * (one write per external API call) does not emit a Mongoose audit event
 * per call.
 *
 * @returns {Promise<{ ok: boolean, value: number }>} `value` is the new
 *   value on success, the current value on refusal.
 */
export const incrementWithinLimit = async ({
  tenantId,
  metric,
  period = 'current',
  delta = 1,
  max,
  by = null,
  kind = 'current',
  expiresAt = null,
  silent = false,
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isInteger(delta) || delta <= 0) throw new Error('delta must be a positive integer');
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a non-negative integer');
  const key = { tenantId: safeId(tenantId), metric, period };
  if (delta > max) {
    const current = await findOne(tenantId, metric, period);
    return { ok: false, value: current?.value ?? 0 };
  }
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      let doc;
      if (silent) {
        doc = await UsageCounter.collection.findOneAndUpdate(
          { ...key, value: { $lte: max - delta } },
          {
            $inc: { value: delta },
            $set: { lastIncrementedAt: now, updatedAt: now, updatedBy: by },
            $setOnInsert: insertDefaults({ kind, expiresAt }),
          },
          { upsert: true, returnDocument: 'after' },
        );
      } else {
        doc = await UsageCounter.findOneAndUpdate(
          { ...key, value: { $lte: max - delta } },
          {
            $inc: { value: delta },
            $set: { lastIncrementedAt: now, updatedBy: by, kind },
            ...(expiresAt ? { $setOnInsert: { expiresAt } } : {}),
          },
          { new: true, upsert: true, setDefaultsOnInsert: true, lean: true, runValidators: true },
        );
      }
      return { ok: true, value: doc.value };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const current = await findOne(tenantId, metric, period);
      if (!current || current.value > max - delta) {
        return { ok: false, value: current?.value ?? 0 };
      }
      // The row was created concurrently and still has room: retry.
    }
  }
  const current = await findOne(tenantId, metric, period);
  return { ok: false, value: current?.value ?? 0 };
};

/**
 * Unconditional increment through the native driver (no audit event).
 * Used for metered metrics under a soft or absent limit.
 */
export const incrementSilently = async ({
  tenantId,
  metric,
  period,
  delta = 1,
  by = null,
  kind = 'cumulative',
  expiresAt = null,
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isInteger(delta) || delta <= 0) throw new Error('delta must be a positive integer');
  const now = new Date();
  const doc = await UsageCounter.collection.findOneAndUpdate(
    { tenantId: safeId(tenantId), metric, period },
    {
      $inc: { value: delta },
      $set: { lastIncrementedAt: now, updatedAt: now, updatedBy: by },
      $setOnInsert: insertDefaults({ kind, expiresAt }),
    },
    { upsert: true, returnDocument: 'after' },
  );
  return { value: doc.value };
};

/**
 * Decrement by `delta` but never below zero, in one atomic update. A
 * missing row is left missing (there is nothing to give back).
 *
 * @returns {Promise<{ value: number }>}
 */
export const decrementClamped = async ({
  tenantId,
  metric,
  period = 'current',
  delta = 1,
  by = null,
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isInteger(delta) || delta <= 0) throw new Error('delta must be a positive integer');
  const doc = await UsageCounter.findOneAndUpdate(
    { tenantId: safeId(tenantId), metric, period },
    [
      {
        $set: {
          value: { $max: [0, { $subtract: [{ $ifNull: ['$value', 0] }, delta] }] },
          lastIncrementedAt: '$$NOW',
          // $literal: an actor id must never be read as a field path.
          updatedBy: { $literal: by },
        },
      },
    ],
    { new: true, lean: true },
  );
  return { value: doc?.value ?? 0 };
};

/**
 * Reconciliation write guarded by compare-and-set: the counter is set to
 * `value` only if it still holds exactly what the caller read (`expected`),
 * so an increment or release that ran in between is never overwritten.
 * `expected: null` means "the row did not exist": it is created, but an
 * existing row (created concurrently) is left untouched.
 *
 * @returns {Promise<boolean>} true when the write happened.
 */
export const compareAndSet = async ({
  tenantId,
  metric,
  period = 'current',
  expected,
  value,
  by = null,
  kind = 'current',
} = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw new Error(`Unknown usage metric: ${metric}`);
  }
  if (!Number.isInteger(value) || value < 0) throw new Error('value must be a non-negative integer');
  const key = { tenantId: safeId(tenantId), metric, period };
  const now = new Date();
  if (!expected) {
    const res = await UsageCounter.collection.updateOne(
      key,
      {
        $setOnInsert: {
          ...insertDefaults({ kind, expiresAt: null }),
          value,
          lastReconciledAt: now,
          lastIncrementedAt: null,
          updatedAt: now,
          updatedBy: by,
        },
      },
      { upsert: true },
    );
    return res.upsertedCount === 1;
  }
  const res = await UsageCounter.collection.updateOne(
    { ...key, value: expected.value, lastIncrementedAt: expected.lastIncrementedAt ?? null },
    { $set: { value, lastReconciledAt: now, updatedAt: now, updatedBy: by, kind } },
  );
  return res.modifiedCount === 1;
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
  incrementWithinLimit,
  incrementSilently,
  decrementClamped,
  compareAndSet,
  setToActual,
  list,
  _meta: { tenancy: 'tenant', unique: ['tenantId', 'metric', 'period'] },
};
