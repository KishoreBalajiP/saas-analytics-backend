/**
 * DeliveryRun (delivery, roadmap 3.4).
 *
 * PURPOSE
 *   One row per delivery of one payload to one recipient or destination
 *   (scheduled report artefact, alert notification, ...). It is the
 *   per-delivery history: status, attempts, timestamps and a sanitised
 *   error. Rows are created and advanced only by `services/delivery`.
 *
 * STATUSES
 *   pending -> sent | retrying -> sent | dead ; skipped (e.g. unsubscribed).
 *
 * SECURITY
 *   Never holds a destination URL or signing secret: only the destination
 *   id and a non-secret label. `lastError` is sanitised before it is stored.
 */

import mongoose from 'mongoose';
import { tenantScope, paginate } from './plugins/index.js';

export const MODEL_NAME = 'DeliveryRun';
export const DELIVERY_STATUSES = Object.freeze(['pending', 'sent', 'retrying', 'dead', 'skipped']);
export const DELIVERY_TYPES = Object.freeze(['email', 'webhook', 'slack', 'teams']);

const deliveryRunSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    kind: { type: String, required: true, maxlength: 40 },
    // Source object (report id / alert id) and, for reports, the run id.
    sourceId: { type: String, default: null },
    reportRunId: { type: String, default: null },
    destinationType: { type: String, enum: [...DELIVERY_TYPES], required: true },
    destinationId: { type: String, default: null },
    // Email address for email deliveries; destination label otherwise.
    recipient: { type: String, default: '' },
    external: { type: Boolean, default: false },
    status: { type: String, enum: [...DELIVERY_STATUSES], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    outboxId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    // What to send (email template + variables, or the notification body).
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

deliveryRunSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
deliveryRunSchema.index({ status: 1, nextAttemptAt: 1 });
deliveryRunSchema.index({ tenantId: 1, sourceId: 1, createdAt: -1 });

deliveryRunSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.payload;
    return ret;
  },
});

deliveryRunSchema.plugin(tenantScope);
deliveryRunSchema.plugin(paginate);

export const DeliveryRun = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, deliveryRunSchema);
export default DeliveryRun;
