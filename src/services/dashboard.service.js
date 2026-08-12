/**
 * Dashboard Service (Sprint 6 - implemented).
 *
 * PURPOSE
 *   Business logic for dashboard authoring, widget authoring and widget
 *   analytics execution. Owns the rules the controllers rely on: safe
 *   query-contract whitelisting, layout/filter sanitisation, share grants,
 *   soft-delete cascades, audit events and the cache-key policy that makes
 *   widget edits bust cached results.
 *
 * RESPONSIBILITY
 *   - Dashboards: list / create / get / update / publish / duplicate /
 *     soft-delete.
 *   - Sharing: grant (`shareDashboard`) + revoke (`revokeShare`) email
 *     grants. Grants are stored + audited; there is no public unauthenticated
 *     read path yet.
 *   - Widgets: list / create / get / update / remove (scoped by
 *     `(tenantId, dashboardId)`).
 *   - Execution: `executeWidget` runs the widget's safe query contract
 *     through the analytics engine, scoped to the widget's tenant-owned
 *     dataset connector; `viewDashboard` runs every widget and reports
 *     partial failures per-widget.
 *
 * CACHE POLICY
 *   The analytics cache key encodes the effective query PLUS the widget and
 *   dashboard identities and their `updatedAt` revisions. Editing a widget
 *   (or its dashboard filters) therefore immediately busts its cached
 *   results; underlying data changes still honour the analytics TTL.
 *   History persistence (AnalyticsQuery) is deliberately NOT written for
 *   widget reads - only explicit `/analytics` runs create history.
 *
 * CODING GUIDELINES
 *   - Mixed (JSON) fields are validated and whitelisted here, never trusted
 *     as-is from clients.
 *   - Audit writes are best-effort: a dashboard write must never fail
 *     because the trail write failed.
 *   - Cross-tenant leakage is prevented by tenant-scoped reads of the
 *     dashboard, the widget AND its dataset connector before execution.
 */

import ApiError from '../utils/ApiError.js';
import {
  Dashboard,
  DASHBOARD_STATUSES,
  DATE_RANGE_PRESETS,
  DASHBOARD_LIMITS,
} from '../models/Dashboard.js';
import { WIDGET_TYPES, WIDGET_LIMITS, QUERY_FIELDS } from '../models/Widget.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as auditLogService from './auditLog.service.js';
import * as analyticsCache from './analytics.cache.js';
import * as engine from './analytics.engine.js';

const { MAX_WIDGETS_PER_DASHBOARD, MAX_WIDGETS_EXECUTED_PER_REQUEST, WIDGET_CACHE_TTL_SEC } = DASHBOARD_LIMITS;

/* ------------------------------ helpers ---------------------------------- */

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidDate(value) {
  return value !== undefined && value !== null && !Number.isNaN(new Date(value).getTime());
}

/** Audit a dashboard-domain event. Best-effort: never throw into the caller. */
async function audit({ tenantId, actorId, action, resourceId, before, after }) {
  try {
    await auditLogService.emit({
      actor: actorId ? { type: 'user', id: actorId } : { type: 'system', id: 'system' },
      action,
      module: 'dashboards',
      resource: { type: 'dashboard', id: String(resourceId) },
      before,
      after,
      tenantId,
    });
  } catch {
    // best-effort trail write; the dashboard operation already succeeded.
  }
}

function sanitizeLayout(layout) {
  const src = layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {};
  return {
    columns: clampInt(src.columns, 12, DASHBOARD_LIMITS.LAYOUT_COLUMNS_MIN, DASHBOARD_LIMITS.LAYOUT_COLUMNS_MAX),
    rowHeight: clampInt(src.rowHeight, 80, DASHBOARD_LIMITS.LAYOUT_ROW_HEIGHT_MIN, DASHBOARD_LIMITS.LAYOUT_ROW_HEIGHT_MAX),
  };
}

function sanitizeDateRange(dateRange) {
  if (dateRange === undefined || dateRange === null) return null;
  if (typeof dateRange !== 'object' || Array.isArray(dateRange)) {
    throw ApiError.badRequest('dateRange must be an object');
  }
  const preset = DATE_RANGE_PRESETS.includes(dateRange.preset) ? dateRange.preset : null;
  if (!preset) throw ApiError.badRequest(`dateRange.preset must be one of ${DATE_RANGE_PRESETS.join(', ')}`);
  if (preset === 'custom' && (!isValidDate(dateRange.from) || !isValidDate(dateRange.to))) {
    throw ApiError.badRequest('custom date range requires valid from and to dates');
  }
  const out = { preset };
  if (dateRange.from !== undefined) out.from = dateRange.from;
  if (dateRange.to !== undefined) out.to = dateRange.to;
  return out;
}

function sanitizeFilters(filters) {
  if (filters === undefined || filters === null) return filters;
  if (typeof filters !== 'object' || Array.isArray(filters)) throw ApiError.badRequest('filters must be an object');
  const out = {};
  if (filters.dateRange !== undefined) out.dateRange = sanitizeDateRange(filters.dateRange);
  if (filters.filters !== undefined) {
    if (!Array.isArray(filters.filters)) throw ApiError.badRequest('filters.filters must be an array');
    out.filters = filters.filters;
  }
  if (filters.filtersOp !== undefined) {
    if (!['and', 'or'].includes(filters.filtersOp)) throw ApiError.badRequest('filtersOp must be "and" or "or"');
    out.filtersOp = filters.filtersOp;
  }
  return out;
}

function sanitizeRefresh(refresh) {
  if (refresh === undefined || refresh === null) return refresh;
  if (typeof refresh !== 'object' || Array.isArray(refresh)) throw ApiError.badRequest('refresh must be an object');
  const out = {};
  if (refresh.enabled !== undefined) out.enabled = Boolean(refresh.enabled);
  if (refresh.intervalSec !== undefined) {
    const n = Number(refresh.intervalSec);
    if (!Number.isFinite(n) || n < 30 || n > 86400) {
      throw ApiError.badRequest('refresh.intervalSec must be between 30 and 86400 seconds');
    }
    out.intervalSec = Math.round(n);
  }
  return out;
}

function sanitizePosition(position) {
  const src = position && typeof position === 'object' && !Array.isArray(position) ? position : {};
  return {
    x: Math.max(WIDGET_LIMITS.POSITION_X_MIN, Number(src.x) || 0),
    y: Math.max(WIDGET_LIMITS.POSITION_Y_MIN, Number(src.y) || 0),
    w: clampInt(src.w, 4, WIDGET_LIMITS.POSITION_W_MIN, WIDGET_LIMITS.POSITION_W_MAX),
    h: clampInt(src.h, 4, WIDGET_LIMITS.POSITION_H_MIN, WIDGET_LIMITS.POSITION_H_MAX),
  };
}

/** Whitelist a widget's analytics query to the safe contract fields. */
function sanitizeWidgetQuery(query) {
  if (query === undefined || query === null) return query;
  if (typeof query !== 'object' || Array.isArray(query)) throw ApiError.badRequest('query must be an object');
  const out = {};
  for (const key of QUERY_FIELDS) {
    if (query[key] !== undefined) out[key] = query[key];
  }
  if (out.filtersOp !== undefined && !['and', 'or'].includes(out.filtersOp)) {
    throw ApiError.badRequest('query.filtersOp must be "and" or "or"');
  }
  if (out.dateRange !== undefined) out.dateRange = sanitizeDateRange(out.dateRange);
  return out;
}

function sanitizeWidgetPatch(patch = {}) {
  const out = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > WIDGET_LIMITS.NAME_MAX) {
      throw ApiError.badRequest('widget name must be a non-empty string up to 120 characters');
    }
    out.name = patch.name.trim();
  }
  if (patch.type !== undefined) {
    if (!WIDGET_TYPES.includes(patch.type)) throw ApiError.badRequest(`widget type must be one of ${WIDGET_TYPES.join(', ')}`);
    out.type = patch.type;
  }
  if (patch.datasetId !== undefined) out.datasetId = patch.datasetId;
  if (patch.query !== undefined) out.query = sanitizeWidgetQuery(patch.query);
  if (patch.visualization !== undefined) out.visualization = patch.visualization;
  if (patch.position !== undefined) out.position = sanitizePosition(patch.position);
  return out;
}

function sanitizeDashboardPatch(patch = {}) {
  const out = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > DASHBOARD_LIMITS.NAME_MAX) {
      throw ApiError.badRequest('dashboard name must be a non-empty string up to 120 characters');
    }
    out.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string' || patch.description.length > DASHBOARD_LIMITS.DESCRIPTION_MAX) {
      throw ApiError.badRequest('description must be a string up to 1000 characters');
    }
    out.description = patch.description;
  }
  if (patch.status !== undefined) {
    if (!DASHBOARD_STATUSES.includes(patch.status)) throw ApiError.badRequest(`status must be one of ${DASHBOARD_STATUSES.join(', ')}`);
    out.status = patch.status;
  }
  if (patch.layout !== undefined) out.layout = sanitizeLayout(patch.layout);
  if (patch.filters !== undefined) out.filters = sanitizeFilters(patch.filters);
  if (patch.refresh !== undefined) out.refresh = sanitizeRefresh(patch.refresh);
  return out;
}

/** Resolve a date-range preset (or explicit range) into `{ from, to }` ISO strings. */
function resolveDateRange(dateRange, now = new Date()) {
  if (!dateRange || typeof dateRange !== 'object') return null;
  const { preset, from, to } = dateRange;
  if (!preset) return { from: from ?? null, to: to ?? null };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  switch (preset) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'yesterday': {
      const day = new Date(now);
      day.setDate(day.getDate() - 1);
      return { from: startOfDay(day).toISOString(), to: endOfDay(day).toISOString() };
    }
    case 'last_7_days': {
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'last_30_days': {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'this_month':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString(),
      };
    case 'previous_month':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).toISOString(),
      };
    case 'custom':
      return { from: from ?? null, to: to ?? null };
    default:
      return null;
  }
}

/**
 * Merge dashboard default filters + the widget's query + request overrides
 * into the effective engine parameters. Precedence: request overrides >
 * widget query > dashboard defaults.
 */
function buildWidgetParams({ widget, dashboard, overrides = {} }) {
  const widgetQuery = widget.query && typeof widget.query === 'object' && !Array.isArray(widget.query) ? widget.query : {};
  const dashboardFilters = dashboard?.filters && typeof dashboard.filters === 'object' ? dashboard.filters : {};

  return {
    filters: overrides.filters ?? widgetQuery.filters ?? dashboardFilters.filters ?? [],
    filtersOp: overrides.filtersOp ?? widgetQuery.filtersOp ?? dashboardFilters.filtersOp ?? 'and',
    dateRange: resolveDateRange(overrides.dateRange ?? widgetQuery.dateRange ?? dashboardFilters.dateRange ?? null),
    metrics: widgetQuery.metrics ?? [],
    groupBy: widgetQuery.groupBy ?? [],
    orderBy: widgetQuery.orderBy ?? [],
    pagination: widgetQuery.pagination ?? {},
  };
}

/** Cache key = effective-query hash + widget + dashboard revisions. */
function buildWidgetCacheKey({ tenantId, widget, dashboard, params }) {
  const base = analyticsCache.buildCacheKey({
    tenantId,
    connectorIds: [String(widget.datasetId)],
    ...params,
  });
  const rev = (value) => (value ? new Date(value).getTime() : 0);
  return `${base}:widget:${widget._id}:dash:${dashboard._id}:w${rev(widget.updatedAt)}:d${rev(dashboard.updatedAt)}`;
}

/** Verify the widget's dataset is a connector owned by the tenant. */
async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('widget dataset must be a connector owned by the tenant');
  return connector;
}

/* ------------------------------ dashboards -------------------------------- */

/** Paginated, tenant-scoped dashboard list (optional status/search filter). */
export async function listDashboards({ tenantId, page = 1, limit = 20, status, search } = {}) {
  const filter = {};
  if (status && DASHBOARD_STATUSES.includes(status)) filter.status = status;
  if (search && typeof search === 'string' && search.trim()) {
    filter.name = { $regex: escapeRegExp(search.trim()), $options: 'i' };
  }
  return dashboardRepository.list({ tenantId, filter, page, limit });
}

/** Create a dashboard (draft by default). */
export async function createDashboard({ tenantId, actorId = null, name, description = '', layout, filters, refresh } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw ApiError.badRequest('dashboard name is required');
  const saved = await dashboardRepository.create({
    tenantId,
    name: name.trim(),
    description: description ?? '',
    layout: sanitizeLayout(layout),
    filters: filters !== undefined ? sanitizeFilters(filters) : null,
    refresh: refresh !== undefined ? sanitizeRefresh(refresh) : { enabled: false, intervalSec: 300 },
    createdBy: actorId,
  });
  await audit({
    tenantId, actorId, action: 'dashboard.created', resourceId: String(saved._id),
    after: { name: saved.name, status: saved.status },
  });
  return saved;
}

/** Fetch a dashboard (optionally with its widgets). */
export async function getDashboard({ tenantId, dashboardId, includeWidgets = false } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  if (!includeWidgets) return { dashboard };
  const widgets = await widgetRepository.list({
    tenantId,
    dashboardId,
    page: 1,
    limit: MAX_WIDGETS_PER_DASHBOARD,
  });
  return { dashboard, widgets: widgets.docs };
}

/** Update a dashboard (whitelisted fields only). */
export async function updateDashboard({ tenantId, dashboardId, actorId = null, patch = {} } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const updates = sanitizeDashboardPatch(patch);
  if (Object.keys(updates).length === 0) return dashboard;
  updates.updatedBy = actorId;
  const updated = await dashboardRepository.update(dashboardId, updates);
  if (!updated) throw ApiError.notFound('Dashboard not found');
  await audit({
    tenantId, actorId, action: 'dashboard.updated', resourceId: dashboardId,
    before: { name: dashboard.name, description: dashboard.description, status: dashboard.status },
    after: { name: updated.name, description: updated.description, status: updated.status },
  });
  return updated;
}

/** Publish a dashboard (draft -> published). */
export async function publishDashboard({ tenantId, dashboardId, actorId = null } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  if (dashboard.status === 'published') return dashboard;
  if (dashboard.status !== 'draft') {
    throw ApiError.badRequest(`only draft dashboards can be published (current: ${dashboard.status})`);
  }
  const updated = await dashboardRepository.update(dashboardId, { status: 'published', updatedBy: actorId });
  if (!updated) throw ApiError.notFound('Dashboard not found');
  await audit({
    tenantId, actorId, action: 'dashboard.published', resourceId: dashboardId,
    before: { status: 'draft' }, after: { status: 'published' },
  });
  return updated;
}

/** Duplicate a dashboard and all of its widgets (copy is a fresh draft). */
export async function duplicateDashboard({ tenantId, dashboardId, actorId = null } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const widgets = await widgetRepository.list({ tenantId, dashboardId, page: 1, limit: MAX_WIDGETS_PER_DASHBOARD });

  const copy = await dashboardRepository.create({
    tenantId,
    name: `${dashboard.name} (copy)`,
    description: dashboard.description ?? '',
    status: 'draft',
    layout: dashboard.layout ?? { columns: 12, rowHeight: 80 },
    filters: dashboard.filters ?? null,
    refresh: dashboard.refresh ?? { enabled: false, intervalSec: 300 },
    shares: [],
    createdBy: actorId,
  });
  for (const w of widgets.docs) {
    await widgetRepository.create({
      tenantId,
      dashboardId: copy._id,
      name: w.name,
      type: w.type,
      datasetId: w.datasetId,
      query: w.query ?? null,
      visualization: w.visualization ?? {},
      position: w.position ?? { x: 0, y: 0, w: 4, h: 4 },
      createdBy: actorId,
    });
  }
  await audit({
    tenantId, actorId, action: 'dashboard.duplicated', resourceId: dashboardId,
    after: { copyId: String(copy._id), widgetCount: widgets.docs.length },
  });
  return copy;
}

/** Soft-delete a dashboard and cascade to its widgets. */
export async function deleteDashboard({ tenantId, dashboardId, actorId = null } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  await dashboardRepository.remove(dashboardId, actorId);
  await widgetRepository.softDeleteByDashboard(dashboardId, actorId);
  await audit({ tenantId, actorId, action: 'dashboard.deleted', resourceId: dashboardId });
  return true;
}

/* ------------------------------ sharing ----------------------------------- */

/** Grant a (revocable) email share on a dashboard. */
export async function shareDashboard({ tenantId, dashboardId, actorId = null, email, role = 'viewer', expiresAt = null } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) throw ApiError.badRequest('email is required');
  if (dashboard.shares?.some((s) => s.email === normalized)) {
    throw ApiError.conflict(`${normalized} already has access to this dashboard`);
  }
  const share = { email: normalized, role, enabled: true, expiresAt: expiresAt || null, createdBy: actorId };
  const updated = await dashboardRepository.addShare(dashboardId, share);
  if (!updated) throw ApiError.notFound('Dashboard not found');
  const added = updated.shares?.[updated.shares.length - 1] ?? share;
  await audit({
    tenantId, actorId, action: 'dashboard.shared', resourceId: dashboardId,
    after: { email: normalized, role },
  });
  return added;
}

/** Revoke a share grant by its sub-document id. */
export async function revokeShare({ tenantId, dashboardId, actorId = null, shareId } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const existing = dashboard.shares?.find((s) => String(s._id) === String(shareId));
  if (!existing) throw ApiError.notFound('Share entry not found');
  const updated = await dashboardRepository.removeShare(dashboardId, shareId);
  if (!updated) throw ApiError.notFound('Dashboard not found');
  await audit({
    tenantId, actorId, action: 'dashboard.share_revoked', resourceId: dashboardId,
    before: { email: existing.email },
  });
  return true;
}

/* ------------------------------- widgets ---------------------------------- */

/** Paginated widget list for a dashboard. */
export async function listWidgets({ tenantId, dashboardId, page = 1, limit = 50 } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  return widgetRepository.list({ tenantId, dashboardId, page, limit });
}

/** Create a widget on a dashboard (dataset must be tenant-owned). */
export async function createWidget({ tenantId, dashboardId, actorId = null, data = {} } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  if (typeof data.name !== 'string' || !data.name.trim()) throw ApiError.badRequest('widget name is required');
  if (!WIDGET_TYPES.includes(data.type)) throw ApiError.badRequest(`widget type must be one of ${WIDGET_TYPES.join(', ')}`);
  await assertDatasetOwned(tenantId, data.datasetId);
  const count = await widgetRepository.countByDashboard(dashboardId);
  if (count >= MAX_WIDGETS_PER_DASHBOARD) {
    throw ApiError.conflict(`dashboard supports at most ${MAX_WIDGETS_PER_DASHBOARD} widgets`);
  }
  const saved = await widgetRepository.create({
    tenantId,
    dashboardId,
    name: data.name.trim(),
    type: data.type,
    datasetId: data.datasetId,
    query: sanitizeWidgetQuery(data.query),
    visualization: data.visualization ?? {},
    position: sanitizePosition(data.position),
    createdBy: actorId,
  });
  await audit({
    tenantId, actorId, action: 'widget.created', resourceId: String(saved._id),
    after: { dashboardId: String(dashboardId), name: saved.name, type: saved.type },
  });
  return saved;
}

/** Fetch a single widget (scoped by tenant + dashboard). */
export async function getWidget({ tenantId, dashboardId, widgetId } = {}) {
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  return widget;
}

/** Update a widget (whitelisted fields only; dataset re-verified when changed). */
export async function updateWidget({ tenantId, dashboardId, widgetId, actorId = null, patch = {} } = {}) {
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  const updates = sanitizeWidgetPatch(patch);
  if (updates.datasetId !== undefined) await assertDatasetOwned(tenantId, updates.datasetId);
  if (Object.keys(updates).length === 0) return widget;
  updates.updatedBy = actorId;
  const updated = await widgetRepository.update(widgetId, updates);
  if (!updated) throw ApiError.notFound('Widget not found');
  await audit({
    tenantId, actorId, action: 'widget.updated', resourceId: widgetId,
    after: { dashboardId: String(dashboardId), name: updated.name, type: updated.type },
  });
  return updated;
}

/** Soft-delete a widget. */
export async function removeWidget({ tenantId, dashboardId, widgetId, actorId = null } = {}) {
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  await widgetRepository.remove(widgetId, actorId);
  await audit({
    tenantId, actorId, action: 'widget.deleted', resourceId: widgetId,
    after: { dashboardId: String(dashboardId) },
  });
  return true;
}

/* ------------------------------ execution --------------------------------- */

/**
 * Execute a single widget against the analytics engine.
 *
 * Isolation is enforced before any query runs: the dashboard must belong to
 * the tenant, the widget must belong to that dashboard, and the dataset
 * connector must be owned by the tenant. The engine additionally injects
 * `tenantId` into its base `$match` as a second line of defence.
 */
export async function executeWidget({ tenantId, dashboardId, widgetId, overrides = {} } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  await assertDatasetOwned(tenantId, widget.datasetId);

  const params = buildWidgetParams({ widget, dashboard, overrides });
  const cacheKey = buildWidgetCacheKey({ tenantId, widget, dashboard, params });

  const { result, cached } = await analyticsCache.cachedQuery(
    cacheKey,
    () => engine.queryRows({ tenantId, connectorIds: [String(widget.datasetId)], ...params }),
    WIDGET_CACHE_TTL_SEC,
  );

  return {
    widgetId: String(widget._id),
    name: widget.name,
    type: widget.type,
    datasetId: String(widget.datasetId),
    cached,
    cacheKey,
    result,
  };
}

/**
 * Execute every widget on a dashboard. Partial failures are allowed: a
 * broken widget must not take down the whole dashboard view.
 */
export async function viewDashboard({ tenantId, dashboardId } = {}) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  const widgets = await widgetRepository.list({
    tenantId,
    dashboardId,
    page: 1,
    limit: MAX_WIDGETS_EXECUTED_PER_REQUEST,
  });

  const settled = await Promise.allSettled(
    widgets.docs.map((w) => executeWidget({ tenantId, dashboardId, widgetId: String(w._id) })),
  );

  const results = settled.map((r, i) => {
    const w = widgets.docs[i];
    if (r.status === 'fulfilled') {
      return { widgetId: String(w._id), name: w.name, status: 'ok', result: r.value };
    }
    return {
      widgetId: String(w._id),
      name: w.name,
      status: 'error',
      error: r.reason?.message ?? 'Widget execution failed',
    };
  });

  return { dashboard, widgets: results };
}

export default {
  listDashboards,
  createDashboard,
  getDashboard,
  updateDashboard,
  publishDashboard,
  duplicateDashboard,
  deleteDashboard,
  shareDashboard,
  revokeShare,
  listWidgets,
  createWidget,
  getWidget,
  updateWidget,
  removeWidget,
  executeWidget,
  viewDashboard,
  _meta: { module: 'dashboards', cacheTtlSec: WIDGET_CACHE_TTL_SEC },
};
