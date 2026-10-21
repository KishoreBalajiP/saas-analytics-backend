/**
 * UsageReservation (roadmap 1.3 - quota capacity held for queued work).
 *
 * PURPOSE
 *   Ledger of usage capacity that a request consumed up front for work a
 *   queue worker finishes later. Today: a webhook delivery reserves its
 *   records against `storedRows` at request time (so the sender gets a
 *   synchronous 409 when the plan is full), and the sync worker's
 *   stored-rows meter draws the rows it really adds from that reservation.
 *
 *   The ledger, not the queue message, is the source of truth for what is
 *   still reserved, so:
 *     - a retried or replayed message draws only what earlier attempts left
 *       (rows they already wrote are not drawn twice or given back);
 *     - reconciliation counts outstanding reservations as in use instead of
 *       erasing them while a delivery waits in the queue.
 *
 *   One document per reservation `(tenantId, metric, key)`; `key` is the
 *   queue job id of the delivery. `remaining` only ever goes down by atomic
 *   draws and up by give-backs of rows a failed write did not store.
 *   Settling (message done) zeroes it and stamps `settledAt`; the document
 *   then lingers for a short while so reconciliation sees the recent change,
 *   and the TTL index removes it. An open reservation older than `staleAt`
 *   (`env.usage.reservationTtlHours`; its message is presumed lost) no
 *   longer counts in reconciliation, which voids it (settles it without a
 *   release) and corrects the counter; a late worker then draws nothing and
 *   meters its rows against the plan instead. `expiresAt` is a backstop
 *   removal for reservations nobody settles or voids.
 *
 * PLUGINS
 *   paginate. Deliberately NOT `audit` (one write per batch would flood the
 *   trail) and NOT `tenantScope` (the repository scopes by `tenantId`).
 *
 * INDEXES
 *   - unique { tenantId, metric, key }
 *   - TTL { expiresAt: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';
import { USAGE_METRICS } from './UsageCounter.js';

export const MODEL_NAME = 'UsageReservation';

const usageReservationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    metric: { type: String, enum: [...USAGE_METRICS], required: true },
    key: { type: String, required: true },
    connectorId: { type: String, default: null },
    reserved: { type: Number, required: true, min: 0 },
    remaining: { type: Number, required: true, min: 0 },
    settledAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    staleAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

usageReservationSchema.index({ tenantId: 1, metric: 1, key: 1 }, { unique: true });
usageReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

usageReservationSchema.plugin(paginate);

export const UsageReservationSchema = usageReservationSchema;
export const UsageReservation = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, usageReservationSchema);
export default UsageReservation;
