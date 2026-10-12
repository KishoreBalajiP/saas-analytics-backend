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

import { PaymentTransaction } from '../models/PaymentTransaction.js';

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

export const listPending = async ({ limit = 50, olderThanMs = 0 } = {}) => {
  const filter = { status: 'pending' };
  if (olderThanMs > 0) {
    filter.createdAt = { $lte: new Date(Date.now() - olderThanMs) };
  }
  return PaymentTransaction.find(filter).sort({ createdAt: 1 }).limit(Math.min(limit, 100)).lean();
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
  listPending,
  listForTenant,
  transitionStatus,
  touchReconciled,
  _meta: { tenancy: 'platform', unique: ['providerOrderId'] },
};
