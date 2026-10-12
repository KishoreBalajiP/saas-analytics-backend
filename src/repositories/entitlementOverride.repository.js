/**
 * Entitlement override repository (Phase 6 - implemented).
 *
 * PURPOSE
 *   Data-access surface for `EntitlementOverride`. Soft-revocation only:
 *   revocation sets `revokedAt` so the audit trail is preserved.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - findActive(tenantId, metric?)
 *   - listByTenant(tenantId, opts)
 *   - listAll(opts)
 *   - create(input, by)
 *   - revoke(id, by, reason)
 *   - findById(id)
 *
 * CODING GUIDELINES
 *   - `findActive` returns only non-revoked, non-expired rows. The
 *     entitlement service consumes this directly.
 *   - `create` is idempotent on `(tenantId, metric, kind)` when an
 *     active row already exists: the existing row is returned and the
 *     new one is dropped, so a re-issued override is a "no-op"
 *     the caller can treat as success.
 */

import { EntitlementOverride } from '../models/EntitlementOverride.js';

function safeId(id) {
  return typeof id === 'string' ? id : id ? String(id) : null;
}

export const findById = async (id) => {
  if (!id) return null;
  return EntitlementOverride.findById(safeId(id)).lean();
};

export const findActive = async (tenantId, metric = null) => {
  if (!tenantId) return [];
  const filter = {
    tenantId: safeId(tenantId),
    revokedAt: null,
  };
  if (metric) filter.metric = metric;
  const rows = await EntitlementOverride.find(filter).lean();
  const now = new Date();
  return rows.filter((r) => !r.expiresAt || r.expiresAt > now);
};

export const listByTenant = async (tenantId, { page = 1, limit = 20, includeRevoked = false } = {}) => {
  if (!tenantId) return { docs: [], total: 0, page, limit, pages: 0 };
  const filter = { tenantId: safeId(tenantId) };
  if (!includeRevoked) filter.revokedAt = null;
  const total = await EntitlementOverride.countDocuments(filter);
  const docs = await EntitlementOverride.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return { docs, total, page, limit, pages: Math.ceil(total / limit) };
};

export const listAll = async ({ page = 1, limit = 20, includeRevoked = true } = {}) => {
  const filter = {};
  if (!includeRevoked) filter.revokedAt = null;
  const total = await EntitlementOverride.countDocuments(filter);
  const docs = await EntitlementOverride.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return { docs, total, page, limit, pages: Math.ceil(total / limit) };
};

export const create = async (input, by) => {
  const existing = await findActive(input.tenantId, input.metric ?? null);
  if (existing.some((r) => r.metric === (input.metric ?? null))) {
    return existing.find((r) => r.metric === (input.metric ?? null));
  }
  const row = await EntitlementOverride.create({
    ...input,
    tenantId: safeId(input.tenantId),
    grantedBy: by ?? input.grantedBy ?? 'system',
  });
  return row.toObject();
};

export const revoke = async (id, by, reason) => {
  if (!id) return null;
  const updated = await EntitlementOverride.findByIdAndUpdate(
    safeId(id),
    { $set: { revokedAt: new Date(), revokedBy: by ?? 'system', revokeReason: reason ?? null } },
    { new: true, lean: true },
  );
  return updated;
};

export default {
  findById,
  findActive,
  listByTenant,
  listAll,
  create,
  revoke,
  _meta: { tenancy: 'tenant', softRevoke: true },
};
