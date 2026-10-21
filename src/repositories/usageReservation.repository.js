/**
 * Usage reservation repository (roadmap 1.3 - quota capacity held for queued work).
 *
 * PURPOSE
 *   Data access for `UsageReservation`, the ledger of capacity a request
 *   consumed up front for work a queue worker finishes later (a webhook
 *   delivery's `storedRows`). See the model for the lifecycle.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - create({ tenantId, metric, key, connectorId, amount, staleAt, expiresAt })
 *   - draw({ tenantId, metric, key, max })        atomic take of up to `max`
 *   - giveBack({ tenantId, metric, key, amount })  undo a draw that stored nothing
 *   - settle({ tenantId, metric, key, lingerMs })  close; returns what was left
 *   - voidStale({ tenantId, now, lingerMs })      close stale ones without a release
 *   - summarize({ tenantId, now })                 outstanding + last change per metric
 *
 * CODING GUIDELINES
 *   - Every query filters by `tenantId` explicitly.
 *   - Writes are single atomic updates; `remaining` never goes below zero.
 *   - Times come from the caller's clock (`now`), the same clock
 *     reconciliation compares against.
 */

import { UsageReservation } from '../models/UsageReservation.js';

function tid(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  return String(tenantId);
}

function lingerUntil(now, lingerMs) {
  return new Date(now.getTime() + Math.max(0, Number(lingerMs) || 0));
}

/** Record a reservation of `amount` (already consumed on the counter). */
export const create = async ({ tenantId, metric, key, connectorId = null, amount, staleAt, expiresAt } = {}) => {
  if (!key) throw new Error('key is required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  const doc = await UsageReservation.create({
    tenantId: tid(tenantId),
    metric,
    key: String(key),
    connectorId: connectorId ? String(connectorId) : null,
    reserved: amount,
    remaining: amount,
    staleAt,
    expiresAt,
  });
  return doc.toObject();
};

/**
 * Atomically take up to `max` from an open reservation.
 *
 * @returns {Promise<number>} the amount taken (0 when settled, voided or gone).
 */
export const draw = async ({ tenantId, metric, key, max, now = new Date() } = {}) => {
  if (!key || !Number.isInteger(max) || max <= 0) return 0;
  const before = await UsageReservation.findOneAndUpdate(
    { tenantId: tid(tenantId), metric, key: String(key), settledAt: null, remaining: { $gt: 0 } },
    [{ $set: { remaining: { $max: [0, { $subtract: ['$remaining', max] }] }, updatedAt: now } }],
    { new: false, lean: true, projection: { remaining: 1 }, timestamps: false },
  );
  return before ? Math.min(before.remaining, max) : 0;
};

/**
 * Return `amount` to an open reservation (a draw whose rows were not stored).
 *
 * @returns {Promise<boolean>} false when the reservation is no longer open.
 */
export const giveBack = async ({ tenantId, metric, key, amount, now = new Date() } = {}) => {
  if (!key || !Number.isInteger(amount) || amount <= 0) return true;
  const res = await UsageReservation.updateOne(
    { tenantId: tid(tenantId), metric, key: String(key), settledAt: null },
    { $inc: { remaining: amount }, $set: { updatedAt: now } },
    { timestamps: false },
  );
  return res.modifiedCount === 1;
};

/**
 * Close an open reservation (its message is done) and keep the document for
 * `lingerMs` so reconciliation sees the recent change.
 *
 * @returns {Promise<number>} what was left (to give back on the counter); 0
 *   when it was already settled, voided or gone (idempotent).
 */
export const settle = async ({ tenantId, metric, key, now = new Date(), lingerMs = 0 } = {}) => {
  if (!key) return 0;
  const before = await UsageReservation.findOneAndUpdate(
    { tenantId: tid(tenantId), metric, key: String(key), settledAt: null },
    { $set: { remaining: 0, settledAt: now, updatedAt: now, expiresAt: lingerUntil(now, lingerMs) } },
    { new: false, lean: true, projection: { remaining: 1 }, timestamps: false },
  );
  return before ? Math.max(0, before.remaining) : 0;
};

/**
 * Void every open reservation of the tenant that went stale (its message is
 * presumed lost): closed without a release, because reconciliation corrects
 * the counter from the real resources instead. `updatedAt` is left alone (a
 * stale reservation is not recent activity).
 *
 * @returns {Promise<number>} reservations voided.
 */
export const voidStale = async ({ tenantId, now = new Date(), lingerMs = 0 } = {}) => {
  const res = await UsageReservation.updateMany(
    { tenantId: tid(tenantId), settledAt: null, staleAt: { $lte: now } },
    { $set: { remaining: 0, settledAt: now, voidedAt: now, expiresAt: lingerUntil(now, lingerMs) } },
    { timestamps: false },
  );
  return res.modifiedCount ?? 0;
};

/**
 * Per metric: capacity still held by open, non-stale reservations, and when
 * any reservation of the tenant last changed (draw, give-back, settle).
 *
 * @returns {Promise<Record<string, { outstanding: number, lastChangedAt: Date|null }>>}
 */
export const summarize = async ({ tenantId, now = new Date() } = {}) => {
  const rows = await UsageReservation.aggregate([
    { $match: { tenantId: tid(tenantId) } },
    {
      $group: {
        _id: '$metric',
        outstanding: {
          $sum: {
            $cond: [
              { $and: [{ $eq: [{ $ifNull: ['$settledAt', null] }, null] }, { $gt: ['$staleAt', now] }] },
              '$remaining',
              0,
            ],
          },
        },
        lastChangedAt: { $max: '$updatedAt' },
      },
    },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, { outstanding: r.outstanding ?? 0, lastChangedAt: r.lastChangedAt ?? null }]));
};

/** One reservation (tests and diagnostics). */
export const findOne = async ({ tenantId, metric, key } = {}) => UsageReservation
  .findOne({ tenantId: tid(tenantId), metric, key: String(key) })
  .lean();

export default {
  create,
  draw,
  giveBack,
  settle,
  voidStale,
  summarize,
  findOne,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
