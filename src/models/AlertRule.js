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
 *   `nextEvaluationAt` is projected from that cron after every evaluation
 *   (triggered, suppressed by the cooldown, not met, no data or failed) so
 *   the scheduler can cheaply scan for due rules. `lastEvaluation` records
 *   the outcome of the most recent evaluation.
 *
 * METRIC CONTRACT
 *   `metric` names an output column of the rule's query: a metric alias
 *   (`<op>_<field>` unless aliased), or `count` when the query defines no
 *   metrics. `groupEvaluation` says how a grouped query is judged: `total`
 *   (the metric over the whole filtered dataset, groups ignored), `any`
 *   (some group meets the condition) or `all` (every group does).
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `alerts`).
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';
import { dependencyHealth } from './plugins/dependencyHealth.js';

export const MODEL_NAME = 'AlertRule';
export const ALERT_CONDITIONS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between']);
export const ALERT_SOURCES = Object.freeze(['widget', 'query']);
export const ALERT_CHANNELS = Object.freeze(['email', 'in_app']);
export const ALERT_EVENT_STATUSES = Object.freeze(['triggered', 'resolved', 'suppressed']);
export const ALERT_GROUP_EVALUATIONS = Object.freeze(['total', 'any', 'all']);
export const ALERT_EVALUATION_OUTCOMES = Object.freeze(['triggered', 'suppressed', 'not_met', 'no_data', 'failed']);

/** Outcome of the most recent evaluation. */
const lastEvaluationSchema = new mongoose.Schema(
  {
    at: { type: Date, default: null },
    outcome: { type: String, enum: [...ALERT_EVALUATION_OUTCOMES], default: null },
    value: { type: Number, default: null },
    groupsEvaluated: { type: Number, default: null },
    groupsMatched: { type: Number, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const scheduleSchema = new mongoose.Schema(
  {
    cron: { type: String, default: '*/5 * * * *' },
    // IANA override; null = run in the workspace time zone (localization.timezone).
    timezone: { type: String, default: null },
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
    // delivery: webhook / Slack / Teams destinations (DeliveryDestination ids).
    destinationIds: [{ type: String }],
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
    groupEvaluation: { type: String, enum: [...ALERT_GROUP_EVALUATIONS], default: 'total' },
    condition: { type: String, enum: [...ALERT_CONDITIONS], required: true },
    threshold: { type: Number, required: true },
    thresholdHigh: { type: Number, default: null },
    schedule: { type: scheduleSchema, default: () => ({}) },
    cooldownMinutes: { type: Number, default: 60, min: 0 },
    repeatMode: { type: String, enum: ['once_per_incident', 'after_cooldown'], default: 'once_per_incident' },
    lastEvaluatedAt: { type: Date, default: null },
    lastTriggeredAt: { type: Date, default: null },
    nextEvaluationAt: { type: Date, default: null },
    lastEvaluation: { type: lastEvaluationSchema, default: null },
    // Scheduler claim (roadmap 1.4): the instance evaluating the due rule
    // and until when. `nextEvaluationAt` is advanced in the same update.
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    notification: { type: notificationSchema, default: () => ({ channels: ['in_app'] }) },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

alertSchema.index({ tenantId: 1, enabled: 1, nextEvaluationAt: 1 });
// Platform-wide due scan used by the scheduler.
alertSchema.index({ enabled: 1, nextEvaluationAt: 1 });

alertSchema.plugin(tenantScope);
alertSchema.plugin(softDelete);
alertSchema.plugin(paginate);
alertSchema.plugin(optimisticConcurrency);
alertSchema.plugin(audit, { module: 'alerts' });
// Broken marker set when the dataset (or the widget's dataset) is deleted;
// cleared when the source is pointed elsewhere.
alertSchema.plugin(dependencyHealth, {
  reference: (doc) => (doc.source === 'widget'
    ? (doc.widgetId ? `widget:${doc.widgetId}` : null)
    : (doc.query?.datasetId ? `connector:${doc.query.datasetId}` : null)),
  referenceFields: ['source', 'widgetId', 'query'],
  enableFields: ['enabled'],
  label: 'alert',
});

export const AlertRuleSchema = alertSchema;
export const AlertRule = mongoose.model(MODEL_NAME, alertSchema);
export default AlertRule;
