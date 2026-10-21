/**
 * AnalyticsQuery (Sprint 5 - implemented).
 *
 * PURPOSE
 *   A persisted record of an analytics query run through `/api/v1/analytics`.
 *   Each row captures the *parameters* the caller asked for, the *result
 *   metadata* (row count, columns, whether it hit the cache) and the terminal
 *   status of any long-running/export job derived from those parameters.
 *
 * WHY IT EXISTS
 *   - History: tenants can revisit past queries via `GET /analytics/queries/:id`.
 *   - Export lineage: an async export (`kind: 'export'`) is a query whose
 *     `status` starts at `pending`, is flipped to `running` by the worker
 *     (`analyticsExport.service.processExport`), then `ready` (artefact in
 *     storage, described by `artifact`) or `failed` (`error`).
 *
 * PLUGINS
 *   tenantScope (queries always belong to one tenant), softDelete,
 *   optimisticConcurrency, paginate, audit (module `analytics`).
 *
 * INDEXES
 *   - { tenantId: 1, createdAt: -1 }
 *   - { tenantId: 1, status: 1 }
 *   - { tenantId: 1, kind: 1, createdBy: 1, createdAt: -1 } (a user's exports)
 *   - { tenantId: 1, 'attribution.datasets.connectorId': 1, createdAt: -1 }
 *   - { tenantId: 1, 'attribution.metricRefs.key': 1, createdAt: -1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, optimisticConcurrency, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'AnalyticsQuery';

export const QUERY_STATUSES = Object.freeze(['draft', 'pending', 'running', 'ready', 'failed']);
/**
 * `query` = a live run recorded for history; `export` = an async export job.
 * ai-catalogue: `run` = an engine run recorded only for attribution by
 * another consumer (widget, report, alert, AI); not listed in the history
 * unless asked for.
 */
export const QUERY_KINDS = Object.freeze(['query', 'export', 'run']);
// ai-catalogue: who ran a query from where (P7 attribution).
export const ATTRIBUTION_SOURCES = Object.freeze(['analytics', 'widget', 'report', 'alert', 'external', 'ai']);
export const EXPORT_FORMATS = Object.freeze(['csv', 'json', 'xlsx']);

/**
 * ai-catalogue: attribution of an executed query (P7). Every computed run
 * records who ran it, from which surface, the datasets it read with their
 * data versions, the resolved window and the engine parameters, so a number
 * can be traced to exactly the data and definitions that produced it.
 */
const attributionSchema = new mongoose.Schema(
  {
    source: { type: String, enum: [...ATTRIBUTION_SOURCES], default: 'analytics' },
    sourceId: { type: String, default: null },
    actorType: { type: String, default: null },
    actorId: { type: String, default: null },
    datasets: [{
      _id: false,
      connectorId: { type: String, required: true },
      dataVersion: { type: Number, default: 0 },
    }],
    window: {
      type: new mongoose.Schema({
        field: { type: String, default: null },
        preset: { type: String, default: null },
        from: { type: Date, default: null },
        to: { type: Date, default: null },
      }, { _id: false }),
      default: null,
    },
    timezone: { type: String, default: null },
    metricRefs: [{
      _id: false,
      key: { type: String, required: true },
      version: { type: Number, required: true },
    }],
    /** The prepared engine parameters (absolute window, pinned metric versions). */
    engine: { type: mongoose.Schema.Types.Mixed, default: null },
    rowCount: { type: Number, default: null },
    total: { type: Number, default: null },
    durationMs: { type: Number, default: null },
  },
  { _id: false },
);

/** Artefact of an async export (kind `export`). */
const artifactSchema = new mongoose.Schema(
  {
    format: { type: String, enum: [...EXPORT_FORMATS], default: 'csv' },
    resultKey: { type: String, default: null },
    fileName: { type: String, default: null },
    contentType: { type: String, default: null },
    size: { type: Number, default: null },
    rowCount: { type: Number, default: null },
    // True only when the export hit the row safety cap (ARTIFACT_MAX_ROWS).
    truncated: { type: Boolean, default: false },
    rowLimit: { type: Number, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    // retention: set when the cleanup job removed the stored file
    // (RETENTION_EXPORT_DAYS); downloads then answer 410 EXPORT_EXPIRED.
    expiredAt: { type: Date, default: null },
  },
  { _id: false },
);

const analyticsQuerySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, trim: true, maxlength: 120, default: null },
    createdBy: { type: String, default: null },

    /** The raw parameters the caller supplied (filters, groupBy, metrics, ...). */
    params: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Connectors this query was restricted to (may be empty = all). */
    connectorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Connector' }],

    status: { type: String, enum: [...QUERY_STATUSES], default: 'ready', index: true },

    kind: { type: String, enum: [...QUERY_KINDS], default: 'query' },

    /** Set for kind `export`: the requested format and, once ready, the artefact. */
    artifact: { type: artifactSchema, default: null },

    /** Outcome metadata - written by the service after the engine runs. */
    resultMeta: {
      type: new mongoose.Schema(
        {
          rowCount: { type: Number, default: 0 },
          columns: [{ type: String }],
          cached: { type: Boolean, default: false },
          cacheKey: { type: String, default: null },
          ttlSec: { type: Number, default: 0 },
          executedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },

    /** Server-side aggregates for the cached result window (count, sum, ...). */
    totals: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Populated when `status === 'failed'`. */
    error: { type: String, default: null },

    // ai-catalogue: P7 attribution of the run.
    attribution: { type: attributionSchema, default: null },
  },
  { timestamps: true },
);

analyticsQuerySchema.index({ tenantId: 1, createdAt: -1 });
analyticsQuerySchema.index({ tenantId: 1, status: 1 });
analyticsQuerySchema.index({ tenantId: 1, kind: 1, createdBy: 1, createdAt: -1 });
// ai-catalogue: "which runs read this dataset / used this metric".
analyticsQuerySchema.index({ tenantId: 1, 'attribution.datasets.connectorId': 1, createdAt: -1 });
analyticsQuerySchema.index({ tenantId: 1, 'attribution.metricRefs.key': 1, createdAt: -1 });

analyticsQuerySchema.plugin(tenantScope);
analyticsQuerySchema.plugin(softDelete);
analyticsQuerySchema.plugin(optimisticConcurrency);
analyticsQuerySchema.plugin(paginate);
analyticsQuerySchema.plugin(audit, { module: 'analytics' });

export const AnalyticsQuerySchema = analyticsQuerySchema;
export const AnalyticsQuery = mongoose.model(MODEL_NAME, analyticsQuerySchema);
export default AnalyticsQuery;
