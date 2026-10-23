/**
 * Subscription repository (Phase 6 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the single canonical Subscription per tenant.
 *   All write methods return lean objects and never expose internal fields
 *   that the service should not see.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findByTenantId(tenantId)        get the current subscription
 *   - findById(id)                    direct id lookup (admin surface)
 *   - list({ page, limit, filter })   paginated admin list
 *   - upsertForTenant(tenantId, doc)  idempotent create-or-update by tenantId
 *   - update(id, patch, { by })       partial update with optimistic concurrency
 *   - appendHistory(tenantId, entry)  append a SubscriptionHistory row
 *   - listHistory(tenantId, opts)     paginated history (admin timeline)
 *   - listExpiring(state, before)     background-job helper
 *   - listLifecycleDue({ now })       billing: rows whose term, trial or
 *                                     grace ended (lifecycle job)
 *   - listRenewalDue({ now, until })  billing: paid terms ending soon
 *                                     (renewal reminders)
 *
 * CODING GUIDELINES
 *   - `tenantId` is the partition key; every method takes it explicitly
 *     because `tenantScope` is intentionally not applied.
 *   - The unique index on `tenantId` makes `upsertForTenant` safe under
 *     concurrent calls (MongoDB serialises the index upsert).
 *   - `update` and `upsertForTenant` use the optimisticConcurrency
 *     plugin: callers MUST pass `{ __v }` if they have read the doc
 *     first. A `null` match is treated as "don't care" (background
 *     jobs / migrations).
 */

import { Subscription } from '../models/Subscription.js';
import { SubscriptionHistory } from '../models/SubscriptionHistory.js';

function safeId(id) {
  try {
    return typeof id === 'string' ? id : String(id);
  } catch {
    return null;
  }
}

export const findByTenantId = async (tenantId) => {
  if (!tenantId) return null;
  return Subscription.findOne({ tenantId: safeId(tenantId) }).lean();
};

export const findById = async (id) => {
  if (!id) return null;
  return Subscription.findById(safeId(id)).lean();
};

export const list = async ({ page = 1, limit = 20, filter = {} } = {}) => {
  const result = await Subscription.paginate(filter, {
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

/**
 * Idempotent create-or-update by `tenantId`. The unique index on `tenantId`
 * makes this safe under concurrent calls.
 */
export const upsertForTenant = async (tenantId, doc, { by = null } = {}) => {
  if (!tenantId) throw new Error('tenantId is required');
  const filter = { tenantId: safeId(tenantId) };
  const update = {
    $set: { ...doc, tenantId: safeId(tenantId), updatedBy: by },
    $setOnInsert: { createdBy: by },
  };
  const options = { new: true, upsert: true, setDefaultsOnInsert: true, lean: true, runValidators: true };
  return Subscription.findOneAndUpdate(filter, update, options);
};

/** Patch an existing subscription by id. */
export const update = async (id, patch, { by = null, expectedVersion = null, expect = null } = {}) => {
  if (!id) return null;
  const filter = { _id: safeId(id) };
  if (expectedVersion !== null) filter.__v = expectedVersion;
  // billing: compare-and-set on fields read by the caller (e.g. `updatedAt`
  // or `lastTransactionId`); a null result means the row moved meanwhile.
  if (expect && typeof expect === 'object') Object.assign(filter, expect);
  const updated = await Subscription.findOneAndUpdate(
    filter,
    { $set: { ...patch, updatedBy: by } },
    { new: true, runValidators: true, lean: true },
  );
  return updated;
};

export const appendHistory = async (tenantId, entry) => {
  if (!tenantId) throw new Error('tenantId is required');
  const row = {
    tenantId: safeId(tenantId),
    occurredAt: new Date(),
    ...entry,
  };
  const created = await SubscriptionHistory.create(row);
  return created.toObject();
};

export const listHistory = async (tenantId, { page = 1, limit = 20 } = {}) => {
  if (!tenantId) return { docs: [], total: 0, page, limit, pages: 0 };
  const filter = { tenantId: safeId(tenantId) };
  const total = await SubscriptionHistory.countDocuments(filter);
  const docs = await SubscriptionHistory.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return { docs, total, page, limit, pages: Math.ceil(total / limit) };
};

/** Background-job helper: list subscriptions whose grace/period end is near. */
export const listExpiring = async ({ state, before } = {}) => {
  if (!state || !before) return [];
  const filter = { state };
  if (state === 'past_due') filter.graceEndsAt = { $lte: before };
  if (state === 'active' || state === 'trialing') {
    filter.currentPeriodEnd = { $lte: before };
  }
  return Subscription.find(filter).limit(500).lean();
};

/**
 * billing: subscriptions the lifecycle job must look at - a paid term,
 * trial or grace window that has ended, a due scheduled change, or a free
 * plan period to roll forward. Bounded batch, oldest first.
 */
export const listLifecycleDue = async ({ now = new Date(), limit = 200 } = {}) => {
  return Subscription.find({
    $or: [
      { state: { $in: ['active', 'trialing', 'canceled'] }, currentPeriodEnd: { $lte: now } },
      { state: 'trialing', trialEndsAt: { $lte: now } },
      { state: 'past_due', graceEndsAt: { $lte: now } },
      { state: 'active', 'scheduledChange.effectiveAt': { $lte: now } },
    ],
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(Math.min(Math.max(1, limit), 1000))
    .lean();
};

/** billing: active or trialing subscriptions whose term ends in (now, until]. */
export const listRenewalDue = async ({ now = new Date(), until, limit = 500 } = {}) => {
  if (!until) return [];
  return Subscription.find({
    state: { $in: ['active', 'trialing'] },
    cancelAtPeriodEnd: { $ne: true },
    currentPeriodEnd: { $gt: now, $lte: until },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(Math.min(Math.max(1, limit), 1000))
    .lean();
};

/** billing: page through non-free subscriptions (migration helper). */
export const listPaidPage = async ({ afterId = null, limit = 200 } = {}) => {
  const filter = { planId: { $ne: 'free' } };
  if (afterId) filter._id = { $gt: afterId };
  return Subscription.find(filter).sort({ _id: 1 }).limit(Math.min(Math.max(1, limit), 1000)).lean();
};

export default {
  listPaidPage,
  listLifecycleDue,
  listRenewalDue,
  findByTenantId,
  findById,
  list,
  upsertForTenant,
  update,
  appendHistory,
  listHistory,
  listExpiring,
  _meta: { tenancy: 'platform', unique: ['tenantId'] },
};
