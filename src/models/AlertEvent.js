/**
 * AlertEvent (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Immutable record of an alert evaluation outcome: triggered, resolved, or
 *   suppressed (cooldown). Events power the alert history surface and are the
 *   audit trail for "this monitor fired at this time with this value".
 *
 * PLUGINS
 *   tenantScope, softDelete, audit (module `alerts`). Events are never
 *   updated once written, only soft-deleted on tenant teardown.
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'AlertEvent';
export const ALERT_EVENT_STATUSES = Object.freeze(['triggered', 'resolved', 'suppressed']);

const eventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    alertId: { type: mongoose.Schema.Types.ObjectId, ref: 'AlertRule', required: true, index: true },
    name: { type: String, default: '' },
    triggeredAt: { type: Date, default: () => new Date() },
    value: { type: Number, default: null },
    condition: { type: String, default: null },
    threshold: { type: Number, default: null },
    thresholdHigh: { type: Number, default: null },
    status: { type: String, enum: [...ALERT_EVENT_STATUSES], default: 'triggered' },
    message: { type: String, default: '' },
    notificationStatus: { type: mongoose.Schema.Types.Mixed, default: null },
    runBy: { type: String, default: null },
  },
  { timestamps: true },
);

eventSchema.index({ tenantId: 1, alertId: 1, triggeredAt: -1 });

eventSchema.plugin(tenantScope);
eventSchema.plugin(softDelete);
eventSchema.plugin(paginate);
eventSchema.plugin(audit, { module: 'alerts' });

export const AlertEventSchema = eventSchema;
export const AlertEvent = mongoose.model(MODEL_NAME, eventSchema);
export default AlertEvent;
