/**
 * Widget (Sprint 6 - implemented).
 *
 * PURPOSE
 *   A single visual element on a Dashboard. The widget is the unit of
 *   analytics execution: it references a tenant-owned connector as its
 *   dataset (`datasetId`) plus a safe analytics query contract (`query`),
 *   a chart type (`type`), and a grid position on the parent dashboard.
 *
 * SAFE QUERY CONTRACT
 *   `query` is a whitelisted subset of the analytics engine contract:
 *   `{ filters, filtersOp, dateRange, metrics, groupBy, orderBy,
 *   pagination }`. Only keys from `QUERY_FIELDS` are ever read when the
 *   widget executes, so a malformed document can never smuggle arbitrary
 *   aggregation stages into the engine.
 *
 * TENANCY
 *   A widget always belongs to a tenant AND a dashboard within that tenant.
 *   Repository reads scope by both `tenantId` and `dashboardId`; the
 *   service additionally verifies the parent dashboard belongs to the
 *   caller's tenant.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `dashboards` — widget lifecycle audits under the parent module).
 *
 * INDEXES
 *   - { tenantId: 1, dashboardId: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Widget';
export const WIDGET_TYPES = Object.freeze(['kpi', 'table', 'bar', 'line', 'area', 'pie']);

/** Whitelist of query keys a widget may carry (safe query contract). */
export const QUERY_FIELDS = Object.freeze([
  'filters',
  'filtersOp',
  'dateRange',
  'metrics',
  'groupBy',
  'orderBy',
  'pagination',
]);

export const WIDGET_LIMITS = Object.freeze({
  NAME_MAX: 120,
  POSITION_X_MIN: 0,
  POSITION_Y_MIN: 0,
  POSITION_W_MIN: 1,
  POSITION_W_MAX: 24,
  POSITION_H_MIN: 1,
  POSITION_H_MAX: 100,
});

const positionSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0, min: WIDGET_LIMITS.POSITION_X_MIN },
    y: { type: Number, default: 0, min: WIDGET_LIMITS.POSITION_Y_MIN },
    w: { type: Number, default: 4, min: WIDGET_LIMITS.POSITION_W_MIN, max: WIDGET_LIMITS.POSITION_W_MAX },
    h: { type: Number, default: 4, min: WIDGET_LIMITS.POSITION_H_MIN, max: WIDGET_LIMITS.POSITION_H_MAX },
  },
  { _id: false },
);

const widgetSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    dashboardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dashboard', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: WIDGET_LIMITS.NAME_MAX },
    type: { type: String, enum: [...WIDGET_TYPES], required: true, index: true },
    // The "dataset" this widget reads from: a tenant-owned connector id.
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Connector', required: true },
    // Safe analytics query contract (whitelisted on execution).
    query: { type: mongoose.Schema.Types.Mixed, default: null },
    // Type-specific presentation config (labels, colors, thresholds...).
    visualization: { type: mongoose.Schema.Types.Mixed, default: {} },
    position: { type: positionSchema, default: () => ({ x: 0, y: 0, w: 4, h: 4 }) },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

widgetSchema.index({ tenantId: 1, dashboardId: 1 });

widgetSchema.plugin(tenantScope);
widgetSchema.plugin(softDelete);
widgetSchema.plugin(paginate);
widgetSchema.plugin(optimisticConcurrency);
widgetSchema.plugin(audit, { module: 'dashboards' });

export const WidgetSchema = widgetSchema;
export const Widget = mongoose.model(MODEL_NAME, widgetSchema);
export default Widget;
