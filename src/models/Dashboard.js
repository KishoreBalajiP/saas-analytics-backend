/**
 * Dashboard (Sprint 6 - implemented).
 *
 * PURPOSE
 *   A tenant-scoped, shareable interactive view of analytics data. A
 *   dashboard owns a set of `Widget` documents (see `models/Widget.js`);
 *   each widget references a tenant-owned connector ("dataset") and a
 *   safe analytics query contract that the dashboard service executes
 *   through the analytics engine on read.
 *
 * VERSIONING NOTE
 *   The architecture brief planned append-only versions with immutable
 *   published copies. Sprint 6 ships a simpler, operationally honest
 *   model: dashboards are mutable (with optimistic concurrency via `__v`),
 *   and widget-edit invalidation is handled by cache-keying on the
 *   widget's `updatedAt` instead of copying documents. This is recorded in
 *   `src/docs/DECISIONS.md`.
 *
 * SHARING
 *   `shares` holds email-address grants (`viewer`) used as the foundation
 *   for the future embed/signed-link surface. There is no public,
 *   unauthenticated read path yet; share grants are stored, revocable and
 *   audited, but do not bypass RBAC.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `dashboards`).
 *
 * INDEXES
 *   - { tenantId: 1, status: 1 }
 *   - { tenantId: 1, name: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Dashboard';
export const DASHBOARD_STATUSES = Object.freeze(['draft', 'published', 'archived']);

/** Date-range presets a dashboard (or widget) filter bar can resolve to. */
export const DATE_RANGE_PRESETS = Object.freeze([
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'previous_month',
  'custom',
]);

/** Shared dashboard/widget limits (authoring guards, not RBAC). */
export const DASHBOARD_LIMITS = Object.freeze({
  NAME_MAX: 120,
  DESCRIPTION_MAX: 1000,
  LAYOUT_COLUMNS_MIN: 1,
  LAYOUT_COLUMNS_MAX: 24,
  LAYOUT_ROW_HEIGHT_MIN: 1,
  LAYOUT_ROW_HEIGHT_MAX: 500,
  MAX_WIDGETS_PER_DASHBOARD: 30,
  MAX_WIDGETS_EXECUTED_PER_REQUEST: 30,
  WIDGET_CACHE_TTL_SEC: 300,
});

const shareSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    role: { type: String, enum: ['viewer'], default: 'viewer' },
    enabled: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  { _id: true, timestamps: false },
);

const dashboardSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: DASHBOARD_LIMITS.NAME_MAX },
    description: { type: String, default: '', maxlength: DASHBOARD_LIMITS.DESCRIPTION_MAX },
    status: { type: String, enum: [...DASHBOARD_STATUSES], default: 'draft', index: true },
    layout: {
      type: mongoose.Schema.Types.Mixed,
      default: { columns: 12, rowHeight: 80 },
    },
    // Dashboard-level default filters: `{ dateRange?, filters?, filtersOp? }`.
    // A widget's own query overrides these at execution time.
    filters: { type: mongoose.Schema.Types.Mixed, default: null },
    // Dashboard-level auto-refresh foundation (UI ticks, not enforced server-side yet).
    refresh: { type: mongoose.Schema.Types.Mixed, default: { enabled: false, intervalSec: 300 } },
    shares: { type: [shareSchema], default: [] },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

dashboardSchema.index({ tenantId: 1, status: 1 });
dashboardSchema.index({ tenantId: 1, name: 1 });

dashboardSchema.plugin(tenantScope);
dashboardSchema.plugin(softDelete);
dashboardSchema.plugin(paginate);
dashboardSchema.plugin(optimisticConcurrency);
dashboardSchema.plugin(audit, { module: 'dashboards' });

export const DashboardSchema = dashboardSchema;
export const Dashboard = mongoose.model(MODEL_NAME, dashboardSchema);
export default Dashboard;
