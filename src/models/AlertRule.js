/**
 * AlertRule (Sprint 7 - implemented).
 *
 * PURPOSE
 *   A threshold-based monitor over an analytics query. On each evaluation
 *   the chosen metric is aggregated and compared against `threshold` using
 *   `condition`; when the condition holds (and the cooldown has elapsed) an
 *   AlertEvent is recorded and notifications are dispatched.
 *
 * EVALUATION
 *   The evaluation cadence is `schedule.cron` (defaults to every 5 minutes).
 *   `nextEvaluationAt` is projected from that cron after every evaluation so
 *   the scheduler can cheaply scan for due rules.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `alerts`).
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'AlertRule';
export const ALERT_CONDITIONS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between']);
export const ALERT_SOURCES = Object.freeze(['widget', 'query']);
export const ALERT_CHANNELS = Object.freeze(['email', 'in_app']);
export const ALERT_EVENT_STATUSES = Object.freeze(['triggered', 'resolved', 'suppressed']);

const scheduleSchema = new mongoose.Schema(
  {
    cron: { type: String, default: '*/5 * * * *' },
    timezone: { type: String, default: 'UTC' },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    channels: [{ type: String, enum: [...ALERT_CHANNELS] }],
    recipients: [
      {
        type: { type: String, enum: ['user', 'email'], default: 'user' },
        value: { type: String, default: '' },
      },
    ],
    template: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const alertSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '' },
    enabled: { type: Boolean, default: true, index: true },
    source: { type: String, enum: [...ALERT_SOURCES], default: 'widget' },
    dashboardId: { type: String, default: null },
    widgetId: { type: String, default: null },
    query: { type: mongoose.Schema.Types.Mixed, default: null },
    metric: { type: String, default: 'count' },
    condition: { type: String, enum: [...ALERT_CONDITIONS], required: true },
    threshold: { type: Number, required: true },
    thresholdHigh: { type: Number, default: null },
    schedule: { type: scheduleSchema, default: () => ({}) },
    cooldownMinutes: { type: Number, default: 60, min: 0 },
    lastEvaluatedAt: { type: Date, default: null },
    lastTriggeredAt: { type: Date, default: null },
    nextEvaluationAt: { type: Date, default: null },
    notification: { type: notificationSchema, default: () => ({ channels: ['in_app'] }) },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

alertSchema.index({ tenantId: 1, enabled: 1, nextEvaluationAt: 1 });

alertSchema.plugin(tenantScope);
alertSchema.plugin(softDelete);
alertSchema.plugin(paginate);
alertSchema.plugin(optimisticConcurrency);
alertSchema.plugin(audit, { module: 'alerts' });

export const AlertRuleSchema = alertSchema;
export const AlertRule = mongoose.model(MODEL_NAME, alertSchema);
export default AlertRule;
