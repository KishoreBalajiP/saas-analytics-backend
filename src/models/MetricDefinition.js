/**
 * MetricDefinition (ai-catalogue, roadmap 4.A1 - "semantic layer lite").
 *
 * PURPOSE
 *   A tenant's named business metric: what "net revenue" or "conversion
 *   rate" means, over which dataset, with which aggregation (or ratio of two
 *   aggregations), default filters, unit, format and direction. Widgets,
 *   reports, alerts, analytics queries and the AI planner reference a metric
 *   as `metric:<key>` instead of repeating (and drifting from) the formula.
 *
 * VERSIONING
 *   One document per (tenant, key, version). Versions are IMMUTABLE: an edit
 *   creates the next version as a draft; only `status` (and its approval /
 *   archive stamps) ever changes on a stored version. `metric:<key>`
 *   resolves to the highest APPROVED version; `metric:<key>@<n>` resolves to
 *   version n while it is approved, so a saved widget can pin a definition.
 *
 * STATUS
 *   draft     created by a person or suggested by the profiler; not usable
 *             by queries until approved.
 *   approved  usable by reference (needs `metrics.approve`).
 *   archived  retired (all versions of the key); no longer resolves.
 *
 * PLUGINS
 *   tenantScope, paginate, audit (module `metrics`).
 *
 * INDEXES
 *   - unique({ tenantId: 1, key: 1, version: 1 })
 *   - { tenantId: 1, key: 1, status: 1, version: -1 } (resolution)
 *   - { tenantId: 1, status: 1, updatedAt: -1 } (catalogue listing)
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'MetricDefinition';

export const METRIC_STATUSES = Object.freeze(['draft', 'approved', 'archived']);
/** Aggregations of a simple metric (and of each side of a ratio). */
export const METRIC_AGGREGATIONS = Object.freeze(['count', 'sum', 'avg', 'min', 'max', 'count_distinct']);
/** `ratio` divides a numerator aggregation by a denominator aggregation. */
export const METRIC_KINDS = Object.freeze([...METRIC_AGGREGATIONS, 'ratio']);
export const METRIC_FORMATS = Object.freeze(['number', 'integer', 'currency', 'percent']);
export const METRIC_DIRECTIONS = Object.freeze(['higher_is_better', 'lower_is_better', 'neutral']);
export const METRIC_SOURCES = Object.freeze(['manual', 'profiler']);
export const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const METRIC_LIMITS = Object.freeze({
  LABEL_MAX: 120,
  DESCRIPTION_MAX: 1000,
  UNIT_MAX: 32,
  FILTERS_MAX: 20,
});

/** One side of a ratio: an aggregation with its own optional filters. */
const ratioPartSchema = new mongoose.Schema(
  {
    aggregation: { type: String, enum: [...METRIC_AGGREGATIONS], required: true },
    field: { type: String, default: null },
    filters: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const metricDefinitionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true, trim: true, immutable: true, match: METRIC_KEY_PATTERN },
    version: { type: Number, required: true, min: 1, immutable: true },
    label: { type: String, required: true, trim: true, maxlength: METRIC_LIMITS.LABEL_MAX, immutable: true },
    description: { type: String, default: '', maxlength: METRIC_LIMITS.DESCRIPTION_MAX, immutable: true },
    // The dataset the metric reads: a tenant-owned connector.
    connectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Connector', required: true, immutable: true },
    aggregation: { type: String, enum: [...METRIC_KINDS], required: true, immutable: true },
    field: { type: String, default: null, immutable: true },
    numerator: { type: ratioPartSchema, default: null, immutable: true },
    denominator: { type: ratioPartSchema, default: null, immutable: true },
    // Engine filter contract ({ field, op, value }); applied to this metric only.
    filters: { type: [mongoose.Schema.Types.Mixed], default: [], immutable: true },
    unit: { type: String, default: null, maxlength: METRIC_LIMITS.UNIT_MAX, immutable: true },
    format: { type: String, enum: [...METRIC_FORMATS], default: 'number', immutable: true },
    direction: { type: String, enum: [...METRIC_DIRECTIONS], default: 'higher_is_better', immutable: true },
    owner: { type: String, default: null, immutable: true },
    source: { type: String, enum: [...METRIC_SOURCES], default: 'manual', immutable: true },
    // Why the profiler suggested it (shown on review).
    rationale: { type: String, default: null, maxlength: 500, immutable: true },

    status: { type: String, enum: [...METRIC_STATUSES], default: 'draft', index: true },
    createdBy: { type: String, default: null, immutable: true },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

metricDefinitionSchema.index({ tenantId: 1, key: 1, version: 1 }, { unique: true });
metricDefinitionSchema.index({ tenantId: 1, key: 1, status: 1, version: -1 });
metricDefinitionSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });

metricDefinitionSchema.plugin(tenantScope);
metricDefinitionSchema.plugin(paginate);
metricDefinitionSchema.plugin(audit, { module: 'metrics' });

export const MetricDefinitionSchema = metricDefinitionSchema;
export const MetricDefinition = mongoose.model(MODEL_NAME, metricDefinitionSchema);
export default MetricDefinition;
