/**
 * SyncRun (roadmap 1.4 - durable jobs).
 *
 * PURPOSE
 *   One record per connector sync: who/what triggered it, its state, how many
 *   attempts it took, how many rows it read and wrote, timings and a sanitised
 *   error. Tenant users see this history on the dataset page; the connector
 *   document keeps only the current state.
 *
 * LIFECYCLE
 *   queued -> running -> succeeded | failed
 *                    \-> retrying -> running ... (queue retry with backoff)
 *   queued|running|retrying -> abandoned  (lease expired; stale-job reaper)
 *   queued|running          -> cancelled  (tenant not active, connector gone)
 *   A running sync renews `leaseUntil`/`heartbeatAt`; the reaper treats an
 *   expired lease as a dead worker.
 *
 * PLUGINS
 *   tenantScope (a sync run always belongs to a tenant), paginate.
 *
 * INDEXES
 *   - { tenantId: 1, connectorId: 1, createdAt: -1 }  history per connector
 *   - { connectorId: 1, status: 1 }                    open runs per connector
 *   - { status: 1, finishedAt: -1 }                    failed runs by time (security detection)
 *   - TTL { expiresAt: 1 }                              RETENTION_SYNC_RUN_DAYS
 */

import mongoose from 'mongoose';
import { tenantScope, paginate } from './plugins/index.js';

export const MODEL_NAME = 'SyncRun';
export const SYNC_RUN_STATUSES = Object.freeze([
  'queued', 'running', 'retrying', 'succeeded', 'failed', 'abandoned', 'cancelled',
]);
export const SYNC_RUN_OPEN_STATUSES = Object.freeze(['queued', 'running', 'retrying']);
export const SYNC_RUN_TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'abandoned', 'cancelled']);
export const SYNC_RUN_TRIGGERS = Object.freeze(['manual', 'webhook', 'recovery', 'schedule']);

const errorSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    message: { type: String, default: null },
  },
  { _id: false },
);

const rowsSchema = new mongoose.Schema(
  {
    received: { type: Number, default: 0 },
    upserted: { type: Number, default: 0 },
    matched: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  { _id: false },
);

const syncRunSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    connectorId: { type: String, required: true },
    trigger: { type: String, enum: [...SYNC_RUN_TRIGGERS], default: 'manual' },
    jobType: { type: String, default: 'ingest' },
    status: { type: String, enum: [...SYNC_RUN_STATUSES], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: null },
    recoveryAttempt: { type: Number, default: 0 },
    recoveredFrom: { type: String, default: null },
    requestedBy: { type: String, default: null },
    instanceId: { type: String, default: null },
    jobId: { type: String, default: null },
    // Client-supplied upload name: truncated (never rejected) so a long name
    // cannot fail an otherwise valid sync.
    filename: {
      type: String,
      default: null,
      maxlength: 255,
      set: (value) => (typeof value === 'string' ? value.slice(0, 255) : value),
    },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    heartbeatAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    rows: { type: rowsSchema, default: () => ({}) },
    error: { type: errorSchema, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

syncRunSchema.index({ tenantId: 1, connectorId: 1, createdAt: -1 });
syncRunSchema.index({ connectorId: 1, status: 1 });
// detection: failed runs by finish time (connector authentication failure rule).
syncRunSchema.index({ status: 1, finishedAt: -1 });
syncRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

syncRunSchema.plugin(tenantScope);
syncRunSchema.plugin(paginate);

export const SyncRunSchema = syncRunSchema;
export const SyncRun = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, syncRunSchema);
export default SyncRun;
