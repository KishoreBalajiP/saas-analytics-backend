/**
 * SecurityAlert (roadmap 2.6 - platform security detection).
 *
 * PURPOSE
 *   One detection raised by a versioned rule in
 *   `services/securityDetection/rules/`. Platform-level: alerts are read and
 *   triaged in the admin portal (`/admin/security-alerts`) by administrators
 *   holding `security.alerts.view` / `security.alerts.update`.
 *
 * LIFECYCLE
 *   open -> acknowledged -> resolved | false_positive
 *   open ----------------> resolved | false_positive
 *   `open` and `acknowledged` are ACTIVE: while an alert is active, further
 *   detections with the same `dedupeKey` merge into it (occurrences,
 *   lastSeenAt, evidence) instead of creating a duplicate. That invariant is
 *   enforced by the unique partial index on `activeKey`, which holds the
 *   dedupe key while the alert is active and is unset when it is closed.
 *
 * EVIDENCE
 *   `evidence.refs` point at the underlying records (LoginAttempt, AuditLog,
 *   AccessLog, AuditExport, SecuritySignal, SyncRun ids) with a timestamp and a short
 *   label; `evidence.counts` / `evidence.details` hold the numbers that made
 *   the rule fire. Never secrets: API keys are referenced by id or public
 *   prefix, webhook connectors by id, webhook URLs by origin only.
 *
 * RETENTION
 *   Follows the audit retention policy (constants/retention.detection.js):
 *   closed alerts are purged `RETENTION_AUDIT_LOG_DAYS` after `closedAt`.
 *
 * PLUGINS
 *   paginate. No tenantScope: platform-level records (`tenantId` is the
 *   affected tenant when there is one, for filtering only). No audit plugin:
 *   the service records every transition as a security event instead.
 *
 * INDEXES
 *   - unique partial { activeKey } (one active alert per dedupe key)
 *   - { status: 1, lastSeenAt: -1 }      (triage queue)
 *   - { severityRank: -1, lastSeenAt: -1 }
 *   - { ruleId: 1, lastSeenAt: -1 }
 *   - { dedupeKey: 1, closedAt: -1 }     (false-positive suppression)
 *   - { tenantId: 1, lastSeenAt: -1 }
 *   - { closedAt: 1 }                    (retention purge)
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'SecurityAlert';

export const ALERT_STATUSES = Object.freeze(['open', 'acknowledged', 'false_positive', 'resolved']);
export const ACTIVE_ALERT_STATUSES = Object.freeze(['open', 'acknowledged']);
export const CLOSED_ALERT_STATUSES = Object.freeze(['false_positive', 'resolved']);
export const ALERT_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
/** Numeric rank for sorting, escalation and the notification threshold. */
export const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
export const EVIDENCE_SOURCES = Object.freeze([
  'login_attempt', 'audit_log', 'access_log', 'audit_export', 'security_signal', 'sync_run', 'queue', 'api_key',
]);
export const NOTE_MAX_LENGTH = 2000;
export const MAX_EVIDENCE_REFS = 50;
export const MAX_HISTORY = 100;

const refSchema = new mongoose.Schema(
  {
    source: { type: String, enum: [...EVIDENCE_SOURCES], required: true },
    id: { type: String, default: null },
    at: { type: Date, default: null },
    label: { type: String, default: '', maxlength: 300 },
  },
  { _id: false },
);

const actorSchema = new mongoose.Schema(
  {
    id: { type: String, default: null },
    display: { type: String, default: null },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    action: {
      type: String,
      enum: ['raised', 'merged', 'escalated', 'acknowledged', 'false_positive', 'resolved', 'notified'],
      required: true,
    },
    by: { type: actorSchema, default: null },
    from: { type: String, default: null },
    to: { type: String, default: null },
    note: { type: String, default: null, maxlength: NOTE_MAX_LENGTH },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    channel: { type: String, required: true },
    // Email address or the webhook ORIGIN (never the full URL).
    target: { type: String, default: null },
    status: { type: String, enum: ['sent', 'queued', 'failed', 'skipped'], required: true },
    code: { type: String, default: null },
    deliveryId: { type: String, default: null },
  },
  { _id: false },
);

const securityAlertSchema = new mongoose.Schema(
  {
    ruleId: { type: String, required: true, trim: true, maxlength: 80 },
    ruleVersion: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, maxlength: 200 },
    summary: { type: String, default: '', maxlength: 1000 },
    severity: { type: String, enum: [...ALERT_SEVERITIES], required: true },
    severityRank: { type: Number, required: true, min: 1, max: 4 },
    status: { type: String, enum: [...ALERT_STATUSES], default: 'open' },
    dedupeKey: { type: String, required: true, maxlength: 400 },
    // Equals dedupeKey while active (open/acknowledged); unset when closed.
    activeKey: { type: String, default: undefined },
    subject: {
      type: { type: String, required: true, maxlength: 40 },
      id: { type: String, required: true, maxlength: 200 },
      display: { type: String, default: null, maxlength: 300 },
    },
    tenantId: { type: String, default: null },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    windowStart: { type: Date, default: null },
    windowEnd: { type: Date, default: null },
    occurrences: { type: Number, default: 1, min: 1 },
    evidence: {
      counts: { type: mongoose.Schema.Types.Mixed, default: null },
      details: { type: mongoose.Schema.Types.Mixed, default: null },
      refs: { type: [refSchema], default: [] },
    },
    owner: { type: actorSchema, default: null },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: actorSchema, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: actorSchema, default: null },
    resolutionNote: { type: String, default: null, maxlength: NOTE_MAX_LENGTH },
    history: { type: [historySchema], default: [] },
    notifiedAt: { type: Date, default: null },
    notifications: { type: [notificationSchema], default: [] },
  },
  { timestamps: true },
);

securityAlertSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } },
);
securityAlertSchema.index({ status: 1, lastSeenAt: -1 });
securityAlertSchema.index({ severityRank: -1, lastSeenAt: -1 });
securityAlertSchema.index({ ruleId: 1, lastSeenAt: -1 });
securityAlertSchema.index({ dedupeKey: 1, closedAt: -1 });
securityAlertSchema.index({ tenantId: 1, lastSeenAt: -1 });
securityAlertSchema.index({ closedAt: 1 });

securityAlertSchema.plugin(paginate);

export const SecurityAlertSchema = securityAlertSchema;
export const SecurityAlert = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, securityAlertSchema);
export default SecurityAlert;
