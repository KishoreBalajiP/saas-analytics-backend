/**
 * PaymentTransaction repository (Phase 6.1).
 *
 * PURPOSE
 *   Data-access surface for provider checkout attempts. Database access
 *   ONLY - no business logic, no signature verification, no subscription
 *   writes. The unique index on `providerOrderId` is the duplicate-
 *   submission guard; `findPendingForTenantPlan` is the idempotent-
 *   checkout anchor.
 */

import { PaymentTransaction, OPEN_STATUSES } from '../models/PaymentTransaction.js';

function safeId(id) {
  try {
    return typeof id === 'string' ? id : String(id);
  } catch {
    return null;
  }
}

export const create = async (doc, { by = null } = {}) => {
  const row = await PaymentTransaction.create({ ...doc, createdBy: by, updatedBy: by });
  return row.toObject();
};

export const findByOrderId = async (providerOrderId) => {
  if (!providerOrderId) return null;
  return PaymentTransaction.findOne({ providerOrderId: String(providerOrderId) }).lean();
};

export const findByPaymentId = async (providerPaymentId) => {
  if (!providerPaymentId) return null;
  return PaymentTransaction.findOne({ providerPaymentId: String(providerPaymentId) }).lean();
};

export const findById = async (id) => {
  if (!id) return null;
  try {
    return await PaymentTransaction.findById(safeId(id)).lean();
  } catch {
    return null;
  }
};

/** Idempotent-checkout anchor: a still-pending attempt for the same
 *  tenant + plan + amount + currency. */
export const findPendingForTenantPlan = async ({ tenantId, planId, amountMinor, currency }) => {
  if (!tenantId || !planId) return null;
  return PaymentTransaction.findOne({
    tenantId: safeId(tenantId),
    planId,
    amountMinor,
    currency,
    status: 'pending',
  })
    .sort({ createdAt: -1 })
    .lean();
};

/** Open checkout attempts for one workspace, newest first. */
export const listOpenForTenant = async (tenantId) => {
  if (!tenantId) return [];
  return PaymentTransaction.find({ tenantId: safeId(tenantId), status: { $in: [...OPEN_STATUSES] } })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
};

export const listPending = async ({ limit = 50, olderThanMs = 0 } = {}) => {
  const filter = { status: 'pending' };
  if (olderThanMs > 0) {
    filter.createdAt = { $lte: new Date(Date.now() - olderThanMs) };
  }
  return PaymentTransaction.find(filter).sort({ createdAt: 1 }).limit(Math.min(limit, 100)).lean();
};

/**
 * billing (finding bil.11): open checkouts due for a provider check, in
 * order of their next check (each row backs off on its own), so stale rows
 * can never block newer ones at the head of the queue.
 */
export const listOpenDue = async ({ now = new Date(), limit = 25 } = {}) => {
  return PaymentTransaction.find({
    status: { $in: [...OPEN_STATUSES] },
    $or: [{ nextReconcileAt: { $lte: now } }, { nextReconcileAt: null }],
  })
    .sort({ nextReconcileAt: 1, createdAt: 1 })
    .limit(Math.min(Math.max(1, limit), 100))
    .lean();
};

/** billing: captured rows whose lifecycle change is not applied yet. */
export const listCapturedUnapplied = async ({ now = new Date(), limit = 25 } = {}) => {
  return PaymentTransaction.find({
    status: 'captured',
    appliedAt: null,
    $or: [{ applyingUntil: null }, { applyingUntil: { $lte: now } }],
  })
    .sort({ capturedAt: 1 })
    .limit(Math.min(Math.max(1, limit), 100))
    .lean();
};

/** billing: record a provider check and when the row is due next. */
export const scheduleNextCheck = async (id, { nextReconcileAt, by = null, incrementAttempts = true } = {}) => {
  if (!id) return null;
  return PaymentTransaction.findOneAndUpdate(
    { _id: safeId(id) },
    {
      $set: { lastReconciledAt: new Date(), nextReconcileAt, updatedBy: by },
      ...(incrementAttempts ? { $inc: { reconcileAttempts: 1 } } : {}),
    },
    { new: true, lean: true },
  );
};

/**
 * billing: take the short claim to apply a captured row's term. Only one
 * processor holds it; the claim lapses on its own after `leaseMs`.
 */
export const claimForApply = async (id, { now = new Date(), leaseMs = 60000 } = {}) => {
  if (!id) return null;
  return PaymentTransaction.findOneAndUpdate(
    {
      _id: safeId(id),
      status: 'captured',
      appliedAt: null,
      $or: [{ applyingUntil: null }, { applyingUntil: { $lte: now } }],
    },
    { $set: { applyingUntil: new Date(now.getTime() + leaseMs) } },
    { new: true, lean: true },
  );
};

/** billing: the term is applied; the row is done. */
export const markApplied = async (id, { at = new Date() } = {}) => {
  if (!id) return null;
  return PaymentTransaction.findOneAndUpdate(
    { _id: safeId(id), status: 'captured' },
    { $set: { appliedAt: at, applyingUntil: null, applyError: null } },
    { new: true, lean: true },
  );
};

/** billing: release a failed apply so a retry can take it. */
export const releaseApply = async (id, { error = null } = {}) => {
  if (!id) return null;
  return PaymentTransaction.findOneAndUpdate(
    { _id: safeId(id), appliedAt: null },
    { $set: { applyingUntil: null, applyError: error ? String(error).slice(0, 300) : null } },
    { new: true, lean: true },
  );
};

export const listForTenant = async (tenantId, { page = 1, limit = 20 } = {}) => {
  if (!tenantId) return { docs: [], total: 0, page, limit, pages: 0 };
  const filter = { tenantId: safeId(tenantId) };
  const total = await PaymentTransaction.countDocuments(filter);
  const docs = await PaymentTransaction.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  // Never leak signatures through the repository; callers shape responses.
  return { docs, total, page, limit, pages: Math.ceil(total / limit) };
};

/** Conditional terminal transition: only applies when the row is still
 *  in one of `fromStatuses`. Returns the updated row or null when the
 *  row already moved (duplicate/out-of-order delivery). */
export const transitionStatus = async (id, { to, fromStatuses, patch = {}, by = null }) => {
  if (!id || !to) return null;
  return PaymentTransaction.findOneAndUpdate(
    { _id: safeId(id), status: { $in: fromStatuses } },
    { $set: { ...patch, status: to, updatedBy: by } },
    { new: true, runValidators: true, lean: true },
  );
};

export const touchReconciled = async (id, { by = null, incrementAttempts = true } = {}) => {
  if (!id) return null;
  const inc = incrementAttempts ? { reconcileAttempts: 1 } : {};
  return PaymentTransaction.findOneAndUpdate(
    { _id: safeId(id) },
    {
      $set: { lastReconciledAt: new Date(), updatedBy: by },
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    },
    { new: true, lean: true },
  );
};

export default {
  create,
  findByOrderId,
  findByPaymentId,
  findById,
  findPendingForTenantPlan,
  listOpenForTenant,
  listPending,
  listOpenDue,
  listCapturedUnapplied,
  scheduleNextCheck,
  claimForApply,
  markApplied,
  releaseApply,
  listForTenant,
  transitionStatus,
  touchReconciled,
  _meta: { tenancy: 'platform', unique: ['providerOrderId'] },
};
