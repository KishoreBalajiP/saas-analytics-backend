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
 *   - Export lineage: an async export is a query whose `status` starts at
 *     `pending`, is flipped to `running` by the worker, then `ready`/`failed`.
 *
 * PLUGINS
 *   tenantScope (queries always belong to one tenant), softDelete,
 *   optimisticConcurrency, paginate, audit (module `analytics`).
 *
 * INDEXES
 *   - { tenantId: 1, createdAt: -1 }
 *   - { tenantId: 1, status: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, optimisticConcurrency, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'AnalyticsQuery';

export const QUERY_STATUSES = Object.freeze(['draft', 'pending', 'running', 'ready', 'failed']);

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
  },
  { timestamps: true },
);

analyticsQuerySchema.index({ tenantId: 1, createdAt: -1 });
analyticsQuerySchema.index({ tenantId: 1, status: 1 });

analyticsQuerySchema.plugin(tenantScope);
analyticsQuerySchema.plugin(softDelete);
analyticsQuerySchema.plugin(optimisticConcurrency);
analyticsQuerySchema.plugin(paginate);
analyticsQuerySchema.plugin(audit, { module: 'analytics' });

export const AnalyticsQuerySchema = analyticsQuerySchema;
export const AnalyticsQuery = mongoose.model(MODEL_NAME, analyticsQuerySchema);
export default AnalyticsQuery;
