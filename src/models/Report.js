/**
 * Report (Sprint 7 - implemented).
 *
 * PURPOSE
 *   A scheduled or one-shot analytics deliverable that produces a frozen
 *   artefact (CSV / JSON / Excel) and delivers it via email or download.
 *   Parameters are persisted with each run so audits can reconstruct what
 *   the user saw; generated binaries live in `src/storage/`, never in Mongo.
 *
 * SOURCES
 *   - `widget`: re-runs a saved dashboard widget (reuses the analytics engine
 *     through `dashboard.service.executeWidget`).
 *   - `query`: runs a whitelisted analytics query (same safe contract as a
 *     widget) stored on the report itself.
 *
 * RUN STATE
 *   Every run appends a `runs` sub-document and mirrors the latest into
 *   `lastRun`. Artefacts are addressed by `runs.$.resultKey` in storage.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `reports`).
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Report';
export const REPORT_STATUSES = Object.freeze(['draft', 'active', 'paused', 'archived']);
export const REPORT_FORMATS = Object.freeze(['json', 'csv', 'xlsx']);
export const REPORT_SOURCES = Object.freeze(['widget', 'query']);
export const RUN_STATUSES = Object.freeze(['pending', 'running', 'ready', 'failed']);
export const TRIGGER_SOURCES = Object.freeze(['manual', 'schedule', 'alert']);

const runSchema = new mongoose.Schema(
  {
    status: { type: String, enum: [...RUN_STATUSES], default: 'pending' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    format: { type: String, enum: [...REPORT_FORMATS], default: 'csv' },
    resultKey: { type: String, default: null },
    rowCount: { type: Number, default: null },
    error: { type: String, default: null },
    filters: { type: mongoose.Schema.Types.Mixed, default: null },
    runBy: { type: String, default: null },
    triggeredBy: { type: String, enum: [...TRIGGER_SOURCES], default: 'manual' },
  },
  { timestamps: true },
);

const scheduleSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    cron: { type: String, default: '0 0 * * *' },
    timezone: { type: String, default: 'UTC' },
    recipients: [
      {
        type: { type: String, enum: ['user', 'external'], default: 'user' },
        value: { type: String, default: '' },
      },
    ],
    format: { type: String, enum: [...REPORT_FORMATS], default: 'csv' },
  },
  { _id: false },
);

const reportSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    ownerId: { type: String, default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '' },
    status: { type: String, enum: [...REPORT_STATUSES], default: 'draft', index: true },
    source: { type: String, enum: [...REPORT_SOURCES], default: 'widget' },
    dashboardId: { type: String, default: null },
    widgetId: { type: String, default: null },
    query: { type: mongoose.Schema.Types.Mixed, default: null },
    format: { type: String, enum: [...REPORT_FORMATS], default: 'csv' },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    schedule: { type: scheduleSchema, default: () => ({}) },
    runs: { type: [runSchema], default: [] },
    lastRun: {
      status: { type: String, enum: [...RUN_STATUSES], default: 'pending' },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      durationMs: { type: Number, default: null },
      resultKey: { type: String, default: null },
      rowCount: { type: Number, default: null },
      error: { type: String, default: null },
      format: { type: String, default: null },
      runBy: { type: String, default: null },
      triggeredBy: { type: String, default: null },
    },
    nextRunAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

reportSchema.index({ tenantId: 1, status: 1 });
reportSchema.index({ tenantId: 1, 'schedule.enabled': 1, nextRunAt: 1 });

reportSchema.plugin(tenantScope);
reportSchema.plugin(softDelete);
reportSchema.plugin(paginate);
reportSchema.plugin(optimisticConcurrency);
reportSchema.plugin(audit, { module: 'reports' });

export const ReportSchema = reportSchema;
export const Report = mongoose.model(MODEL_NAME, reportSchema);
export default Report;
