/**
 * Support Access Repository (roadmap 2.3).
 *
 * PURPOSE
 *   Data access for the support access model: consent / break-glass grants,
 *   durable impersonation records and the per-admin daily impersonation
 *   counter.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - grants: createGrant, findGrant, findActiveGrant, listGrants,
 *     transitionGrant, revokeActiveConsents
 *   - impersonations: createImpersonation, findImpersonationBySession,
 *     listImpersonations, endImpersonation, endImpersonationsForGrant
 *   - counter: incrementDailyCounter, decrementDailyCounter, readDailyCounter
 *
 * CODING GUIDELINES
 *   - Every tenant-owned read filters by `tenantId` explicitly (callers that
 *     act across tenants, e.g. the platform pending queue, say so by
 *     passing `tenantId: null` and are admin-scoped by the service).
 *   - State transitions are single conditional `findOneAndUpdate`s, so two
 *     concurrent decisions on the same grant cannot both win.
 *   - Reads return plain objects (`.lean()`).
 */

import { SupportAccessGrant } from '../models/SupportAccessGrant.js';
import { SupportImpersonation } from '../models/SupportImpersonation.js';
import { SupportImpersonationCounter } from '../models/SupportImpersonationCounter.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';

const MAX_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function clampLimit(limit, fallback = 20) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function clampPage(page) {
  const n = Number(page);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/* -------------------------------- grants --------------------------------- */

/** Persist a new grant. Returns a plain object. */
export const createGrant = async (data) => {
  const doc = await SupportAccessGrant.create(data);
  return doc.toObject();
};

/** Find one grant by its public id, optionally pinned to a tenant. */
export const findGrant = (grantId, { tenantId } = {}) => {
  const filter = { grantId: String(grantId) };
  if (tenantId) filter.tenantId = String(tenantId);
  return SupportAccessGrant.findOne(filter).lean();
};

/**
 * The newest usable grant for a tenant at `now`, optionally limited to a
 * kind and (for break-glass) to the requesting admin.
 */
export const findActiveGrant = ({ tenantId, kind, requestedBy, now = new Date() }) => {
  const filter = {
    tenantId: String(tenantId),
    status: 'active',
    expiresAt: { $gt: now },
  };
  if (kind) filter.kind = kind;
  if (requestedBy) filter.requestedBy = String(requestedBy);
  return SupportAccessGrant.findOne(filter).sort({ expiresAt: -1 }).lean();
};

/** Paginated grant listing. `tenantId: null` lists across tenants (admin queue). */
export const listGrants = async ({ tenantId, status, kind, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (tenantId) filter.tenantId = String(tenantId);
  if (status) filter.status = status;
  if (kind) filter.kind = kind;
  const safePage = clampPage(page);
  const safeLimit = clampLimit(limit);
  const [docs, total] = await Promise.all([
    SupportAccessGrant.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    SupportAccessGrant.countDocuments(filter),
  ]);
  return { docs, total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) };
};

/**
 * Atomically move a grant from one of `fromStatuses` to a new state.
 * Returns the updated grant, or null when the grant was not in a
 * transitionable state (someone else decided first).
 */
export const transitionGrant = ({ grantId, tenantId, fromStatuses, set }) => {
  const filter = { grantId: String(grantId), status: { $in: fromStatuses } };
  if (tenantId) filter.tenantId = String(tenantId);
  return SupportAccessGrant.findOneAndUpdate(filter, { $set: set }, { new: true, lean: true });
};

/** End every active consent of a tenant (a new consent supersedes them). */
export const revokeActiveConsents = async ({ tenantId, by, byType, reason, now = new Date() }) => {
  const active = await SupportAccessGrant.find({ tenantId: String(tenantId), kind: 'consent', status: 'active' })
    .select('grantId')
    .lean();
  if (active.length === 0) return [];
  await SupportAccessGrant.updateMany(
    { tenantId: String(tenantId), grantId: { $in: active.map((g) => g.grantId) }, status: 'active' },
    { $set: { status: 'revoked', revokedAt: now, revokedBy: by ?? null, revokedByType: byType ?? null, revokedReason: reason ?? null } },
  );
  return active.map((g) => g.grantId);
};

/* ---------------------------- impersonations ----------------------------- */

/** Persist a new impersonation record. */
export const createImpersonation = async (data) => {
  const doc = await SupportImpersonation.create(data);
  return doc.toObject();
};

/** Find the record of one support session. */
export const findImpersonationBySession = (sessionId) =>
  SupportImpersonation.findOne({ sessionId: String(sessionId) }).lean();

/** Paginated impersonation listing (tenant history or operator console). */
export const listImpersonations = async ({ tenantId, adminId, status, activeAt, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (tenantId) filter.tenantId = String(tenantId);
  if (adminId) filter.adminId = String(adminId);
  if (status) filter.status = status;
  if (activeAt) {
    filter.status = 'active';
    filter.expiresAt = { $gt: activeAt };
  }
  const safePage = clampPage(page);
  const safeLimit = clampLimit(limit);
  const [docs, total] = await Promise.all([
    SupportImpersonation.find(filter)
      .sort({ startedAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    SupportImpersonation.countDocuments(filter),
  ]);
  return { docs, total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) };
};

/** Mark one active record ended. Returns the updated record or null. */
export const endImpersonation = (sessionId, { endedBy, reason, now = new Date() }) =>
  SupportImpersonation.findOneAndUpdate(
    { sessionId: String(sessionId), status: 'active' },
    { $set: { status: 'ended', endedAt: now, endedBy: endedBy ?? null, endedReason: reason ?? null } },
    { new: true, lean: true },
  );

/** Active records opened under a grant (for the revoke cascade). */
export const findActiveImpersonationsForGrant = (grantId) =>
  SupportImpersonation.find({ grantId: String(grantId), status: 'active' }).lean();

/** Count currently open support sessions in a tenant. */
export const countActiveImpersonations = ({ tenantId, now = new Date() }) =>
  SupportImpersonation.countDocuments({ tenantId: String(tenantId), status: 'active', expiresAt: { $gt: now } });

/** Status of the backing sessions (`sessionId -> status`), for live-state checks. */
export const sessionStatuses = async (sessionIds = []) => {
  if (sessionIds.length === 0) return {};
  const rows = await Session.find({ sessionId: { $in: sessionIds.map(String) } })
    .select('sessionId status expiresAt')
    .lean();
  return Object.fromEntries(rows.map((r) => [r.sessionId, r]));
};

/**
 * Support-related audit rows of one tenant (tenant-visible history), newest
 * first. Only the `support.*` modules, only this tenant.
 */
export const listSupportAuditRows = async ({ tenantId, page = 1, limit = 20 } = {}) => {
  const filter = { tenantId: String(tenantId), module: { $regex: '^support\\.' } };
  const safePage = clampPage(page);
  const safeLimit = clampLimit(limit);
  const [docs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { docs, total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) };
};

/* ------------------------------- counter --------------------------------- */

function counterKey(adminId, now) {
  const day = now.toISOString().slice(0, 10);
  return { id: `${adminId}:${day}`, day };
}

/**
 * Atomically take one slot of an admin's daily impersonation budget.
 * Returns the new count, or null when the cap is already reached.
 *
 * The filter `count < cap` and the increment are one server-side operation.
 * When no counter exists yet the upsert creates it at 1; if a concurrent
 * first insert won (E11000) - or the counter is at the cap so the filter
 * missed and the upsert collided with the existing `_id` - the conditional
 * increment is retried without upsert, which then either succeeds or
 * reports the cap.
 */
export const incrementDailyCounter = async ({ adminId, cap, now = new Date() }) => {
  const { id, day } = counterKey(String(adminId), now);
  const expiresAt = new Date(Date.parse(`${day}T00:00:00.000Z`) + 3 * DAY_MS);
  try {
    const doc = await SupportImpersonationCounter.findOneAndUpdate(
      { _id: id, count: { $lt: cap } },
      { $inc: { count: 1 }, $setOnInsert: { adminId: String(adminId), day, expiresAt } },
      { upsert: true, new: true, lean: true },
    );
    return doc?.count ?? null;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const doc = await SupportImpersonationCounter.findOneAndUpdate(
      { _id: id, count: { $lt: cap } },
      { $inc: { count: 1 } },
      { new: true, lean: true },
    );
    return doc ? doc.count : null;
  }
};

/** Give back one slot (the session could not be created). Never below zero. */
export const decrementDailyCounter = async ({ adminId, now = new Date() }) => {
  const { id } = counterKey(String(adminId), now);
  await SupportImpersonationCounter.updateOne({ _id: id, count: { $gt: 0 } }, { $inc: { count: -1 } });
};

/** Current count for an admin's day (0 when none). */
export const readDailyCounter = async ({ adminId, now = new Date() }) => {
  const { id } = counterKey(String(adminId), now);
  const doc = await SupportImpersonationCounter.findById(id).lean();
  return doc?.count ?? 0;
};

export default {
  createGrant,
  findGrant,
  findActiveGrant,
  listGrants,
  transitionGrant,
  revokeActiveConsents,
  createImpersonation,
  findImpersonationBySession,
  listImpersonations,
  endImpersonation,
  findActiveImpersonationsForGrant,
  countActiveImpersonations,
  sessionStatuses,
  listSupportAuditRows,
  incrementDailyCounter,
  decrementDailyCounter,
  readDailyCounter,
  _meta: { leanReturns: true, tenancy: 'tenant (explicit tenantId filters)' },
};
