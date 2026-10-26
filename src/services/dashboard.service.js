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
 * QUERY CONTRACT
 *   Widget queries, dashboard default filters and view-time overrides are
 *   validated by the analytics engine's strict contract
 *   (`analytics.engine.validateQuery`): unknown or invalid parts are a 400
 *   INVALID_QUERY with field errors (`query.filters[0].op`,
 *   `filters.dateRange.field`, ...), never silently dropped. Relative date
 *   presets are stored as presets and resolved at execution time in the
 *   workspace time zone.
 *
 * PRECEDENCE
 *   dateRange: view override > widget query > dashboard default.
 *   filters:   widget query (with its own filtersOp) > dashboard default;
 *              view-time override filters NARROW the result (AND-ed group).
 *
 * CACHE POLICY
 *   The analytics cache key encodes the prepared query (absolute window,
 *   time zone), the dataset version of the widget's connector, and the
 *   widget and dashboard identities and `updatedAt` revisions. Editing a
 *   widget (or its dashboard filters) or syncing its dataset therefore
 *   immediately busts its cached results.
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
import entitlementService from './entitlement.service.js';
import usageService from './usage.service.js';
import {
  Dashboard,
  DASHBOARD_STATUSES,
  DASHBOARD_LIMITS,
  DASHBOARD_VISIBILITY,
  SHARE_LEVELS,
  SHARE_PRINCIPALS,
} from '../models/Dashboard.js';
import { WIDGET_TYPES, WIDGET_LIMITS, QUERY_FIELDS } from '../models/Widget.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as auditLogService from './auditLog.service.js';
import * as analyticsCache from './analytics.cache.js';
import * as engine from './analytics.engine.js';
// vizbuilder: visualization spec, dataset schema contract, share principals.
import { validateVisualization, resolveVisualization } from './visualizationSpec.js';
import * as datasetSchemaService from './datasetSchema.service.js';
import { UserRole } from '../models/UserRole.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
// ai-catalogue: P7 attribution of computed widget runs.
import { recordRun } from './queryAttribution.service.js';

const { MAX_WIDGETS_PER_DASHBOARD, MAX_WIDGETS_EXECUTED_PER_REQUEST, WIDGET_CACHE_TTL_SEC } = DASHBOARD_LIMITS;

/** Widgets of one dashboard view executed at the same time. */
const VIEW_CONCURRENCY = 4;

/* ------------------------------ helpers ---------------------------------- */

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * Validate a filter envelope `{ dateRange?, filters?, filtersOp? }` (dashboard
 * defaults, view overrides) against the engine contract. Presets are kept.
 */
export function sanitizeFilterEnvelope(envelope, prefix = 'filters.') {
  if (envelope === undefined || envelope === null) return envelope;
  return engine.validateQuery(envelope, { keys: engine.FILTER_ENVELOPE_KEYS, prefix });
}

function sanitizeFilters(filters) {
  return sanitizeFilterEnvelope(filters, 'filters.');
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

/** Default widget size on the 12-column grid: KPI a third, table full width, charts half. */
function defaultWidgetSize(type) {
  if (type === 'kpi') return { w: 4, h: 2 };
  if (type === 'table') return { w: 12, h: 5 };
  return { w: 6, h: 4 };
}

/**
 * First free slot (top to bottom, left to right) for a new widget, so
 * widgets added without a position never land on top of each other.
 */
export function nextWidgetPosition(existing = [], type = 'bar') {
  const { w, h } = defaultWidgetSize(type);
  const taken = existing.map((widget) => sanitizePosition(widget.position));
  const fits = (x, y) => taken.every((p) => x + w <= p.x || p.x + p.w <= x || y + h <= p.y || p.y + p.h <= y);
  const bottom = taken.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  for (let y = 0; y <= bottom; y += 1) {
    for (let x = 0; x + w <= 12; x += 1) if (fits(x, y)) return { x, y, w, h };
  }
  return { x: 0, y: bottom, w, h };
}

/**
 * Validate a widget's analytics query against the engine contract (the
 * `QUERY_FIELDS` subset: the dataset comes from `datasetId`). Unknown keys
 * and invalid parts are a 400 with `query.`-prefixed field errors.
 */
function sanitizeWidgetQuery(query) {
  if (query === undefined || query === null) return query;
  return engine.validateQuery(query, { keys: QUERY_FIELDS, prefix: 'query.' });
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
  if (patch.visualization !== undefined) out.visualization = patch.visualization ?? {};
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
  if (patch.visibility !== undefined) {
    if (!DASHBOARD_VISIBILITY.includes(patch.visibility)) throw ApiError.badRequest(`visibility must be one of ${DASHBOARD_VISIBILITY.join(', ')}`);
    out.visibility = patch.visibility;
  }
  return out;
}

/* ------------------------ vizbuilder: widget checks ------------------------ */

const TOP_LEVEL_QUERY_FIELDS = new Set(['connectorId', 'ingestedAt', 'sourceRowId']);
const NON_NUMERIC_TYPES = new Set(['date', 'datetime', 'boolean']);

/**
 * Check every field and aggregation of a widget query against the dataset
 * schema (contract owner: datasets). Unknown fields and numeric aggregations
 * over non-numeric columns are field errors. Skipped when no schema / no
 * profiled fields exist yet (a dataset that has not synced).
 */
async function assertQueryMatchesSchema(tenantId, datasetId, query) {
  if (!query) return;
  const schema = await datasetSchemaService.getSchema({ tenantId, connectorId: String(datasetId) });
  if (!schema || !Array.isArray(schema.fields) || !schema.fields.length) return;
  const types = new Map(schema.fields.map((f) => [f.name, f.type]));
  const errors = [];
  const check = (field, at) => {
    if (field === undefined || field === null || TOP_LEVEL_QUERY_FIELDS.has(field)) return;
    if (!types.has(field)) errors.push({ field: at, message: `"${field}" is not a field of this dataset` });
  };
  (query.filters ?? []).forEach((f, i) => check(f?.field, `query.filters[${i}].field`));
  (query.groupBy ?? []).forEach((g, i) => check(typeof g === 'string' ? g : g?.field, `query.groupBy[${i}].field`));
  if (query.dateRange?.field) check(query.dateRange.field, 'query.dateRange.field');
  (query.metrics ?? []).forEach((m, i) => {
    if (!m?.field) return;
    check(m.field, `query.metrics[${i}].field`);
    if (['sum', 'avg', 'min', 'max'].includes(m.op) && NON_NUMERIC_TYPES.has(types.get(m.field))) {
      errors.push({ field: `query.metrics[${i}].op`, message: `${m.op} needs a numeric field ("${m.field}" is ${types.get(m.field)})` });
    }
  });
  if (errors.length) throw new ApiError(400, 'Invalid analytics query', { code: engine.QUERY_ERROR_CODES.INVALID_QUERY, errors });
}

/* ------------------------- vizbuilder: sharing ----------------------------- */

/** Access levels, weakest first. */
const ACCESS_RANK = Object.freeze({ view: 1, edit: 2, manage: 3 });

/**
 * Build the caller's access context (controller helper): id, role ids and
 * whether they may manage every dashboard (`dashboards.assign`).
 */
export async function accessContext({ tenantId, userId, permissions = [] } = {}) {
  if (!userId) return null;
  const now = new Date();
  const roleIds = (await UserRole.find({ tenantId, userId, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).select('roleId').lean())
    .map((r) => String(r.roleId));
  return { userId: String(userId), roleIds, canManageAll: permissions.includes('dashboards.assign') };
}

/** The caller's access level on a dashboard: 'manage' | 'edit' | 'view' | null. */
export function accessLevel(dashboard, access) {
  if (!access) return 'manage'; // internal callers (jobs, embeds) are already scoped.
  if (access.canManageAll || (dashboard.createdBy && String(dashboard.createdBy) === access.userId)) return 'manage';
  if (dashboard.visibility !== 'restricted') return 'edit'; // workspace-wide: RBAC decides.
  let best = null;
  for (const s of dashboard.shares ?? []) {
    const match = (s.principalType === 'user' && s.principalId === access.userId)
      || (s.principalType === 'role' && access.roleIds.includes(s.principalId));
    if (match && (!best || ACCESS_RANK[s.level] > ACCESS_RANK[best])) best = s.level;
  }
  return best;
}

/** Throw unless the caller holds `needed` on the dashboard; no access looks like not found. */
function requireAccess(dashboard, access, needed) {
  const level = accessLevel(dashboard, access);
  if (!level) throw ApiError.notFound('Dashboard not found');
  if (ACCESS_RANK[level] < ACCESS_RANK[needed]) {
    throw new ApiError(403, `This dashboard is shared with you as ${level === 'view' ? 'view only' : level}`, { code: 'DASHBOARD_ACCESS_DENIED' });
  }
  return level;
}

/** Load a tenant dashboard and check access. */
async function loadDashboard(tenantId, dashboardId, access, needed) {
  const dashboard = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  requireAccess(dashboard, access, needed);
  return dashboard;
}

/** Mongo filter for dashboards the caller can see in a list. */
function visibleFilter(access) {
  if (!access || access.canManageAll) return {};
  return {
    $or: [
      { visibility: { $ne: 'restricted' } },
      { createdBy: access.userId },
      { shares: { $elemMatch: { principalType: 'user', principalId: access.userId } } },
      ...(access.roleIds.length ? [{ shares: { $elemMatch: { principalType: 'role', principalId: { $in: access.roleIds } } } }] : []),
    ],
  };
}

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/**
 * The effective (unresolved) query of a widget on its dashboard:
 * dateRange from the widget, else the dashboard default; filters from the
 * widget (with its own filtersOp), else the dashboard default pair.
 * Shared by widget execution, widget-source reports and widget-source alerts
 * so all three read the same numbers.
 */
export function mergeWidgetQuery({ widget, dashboard }) {
  const widgetQuery = asObject(widget?.query);
  // A stored query is held to the same contract as a new one: a key outside
  // the widget contract (saved before the strict contract, or an engine
  // option such as `tenantId`) is rejected, never ignored or obeyed.
  engine.validateQuery(widgetQuery, { keys: QUERY_FIELDS });
  const dashboardFilters = asObject(dashboard?.filters);
  const filtersFromWidget = widgetQuery.filters !== undefined && widgetQuery.filters !== null;
  const params = {
    filters: filtersFromWidget ? widgetQuery.filters : dashboardFilters.filters ?? [],
    filtersOp: (filtersFromWidget ? widgetQuery.filtersOp : dashboardFilters.filtersOp) ?? 'and',
    metrics: widgetQuery.metrics ?? [],
    groupBy: widgetQuery.groupBy ?? [],
    orderBy: widgetQuery.orderBy ?? [],
    pagination: widgetQuery.pagination ?? {},
  };
  const dateRange = widgetQuery.dateRange ?? dashboardFilters.dateRange ?? null;
  if (dateRange) params.dateRange = dateRange;
  return params;
}

/**
 * Apply a validated filter envelope on top of a base query: its dateRange
 * replaces the base window, its filters are AND-ed as an extra group (they
 * narrow, never widen, the base result).
 */
export function applyFilterEnvelope(params, envelope) {
  if (!envelope) return params;
  const out = { ...params, filterGroups: [...(params.filterGroups ?? [])] };
  if (envelope.dateRange) out.dateRange = envelope.dateRange;
  if (Array.isArray(envelope.filters) && envelope.filters.length) {
    out.filterGroups.push({ filters: envelope.filters, filtersOp: envelope.filtersOp ?? 'and' });
  }
  return out;
}

/** Cache key = prepared-query hash (incl. dataset version) + widget + dashboard revisions. */
function buildWidgetCacheKey({ tenantId, widget, dashboard, prepared, connector }) {
  const base = analyticsCache.buildCacheKey({
    ...prepared,
    tenantId,
    dataVersions: [{ id: String(connector._id), version: connector.dataVersion ?? 0 }],
  });
  const rev = (value) => (value ? new Date(value).getTime() : 0);
  return `${base}:widget:${widget._id}:dash:${dashboard._id}:w${rev(widget.updatedAt)}:d${rev(dashboard.updatedAt)}`;
}

/** Run `worker` over `items` with at most `limit` in flight; settles like Promise.allSettled. */
async function settleWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Verify the widget's dataset is a connector owned by the tenant. */
async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('widget dataset must be a connector owned by the tenant');
  return connector;
}

/**
 * Every `metric:<key>` reference in a widget query must resolve to an
 * approved (active) metric definition: drafts and archived metrics are not
 * usable in dashboards. Returns field errors (empty when all resolve).
 */
async function metricRefErrors(tenantId, query) {
  const errors = [];
  const metrics = Array.isArray(query?.metrics) ? query.metrics : [];
  for (let i = 0; i < metrics.length; i += 1) {
    const ref = metrics[i]?.ref;
    if (typeof ref !== 'string') continue;
    const { resolveMetricRef } = await import('./metricDefinition.service.js');
    const def = await resolveMetricRef({ tenantId, ref });
    if (!def) errors.push({ field: `query.metrics[${i}].ref`, message: `"${ref}" is not an active metric (it may be a draft, archived or deleted)` });
  }
  return errors;
}

async function assertMetricRefsActive(tenantId, query) {
  const errors = await metricRefErrors(tenantId, query);
  if (errors.length) throw new ApiError(400, 'Invalid analytics query', { code: engine.QUERY_ERROR_CODES.INVALID_QUERY, errors });
}

/**
 * Validate one widget for publishing. Never throws: returns
 * `{ widgetId, name, errors: [{ field, message }] }`.
 */
async function validateWidgetForPublish(tenantId, widget) {
  const errors = [];
  const push = (e) => {
    const list = Array.isArray(e?.errors) ? e.errors : null;
    if (list?.length) errors.push(...list.map((x) => ({ field: x.field ?? null, message: x.message ?? String(x) })));
    else errors.push({ field: null, message: e?.message ?? 'Invalid widget' });
  };
  if (!widget.datasetId) {
    errors.push({ field: 'datasetId', message: 'Widget has no dataset selected' });
  } else {
    try { await assertDatasetOwned(tenantId, widget.datasetId); } catch {
      errors.push({ field: 'datasetId', message: 'Widget dataset is missing or you do not have access to it' });
    }
  }
  if (!errors.length) {
    try {
      const query = sanitizeWidgetQuery(widget.query ?? null);
      await assertQueryMatchesSchema(tenantId, widget.datasetId, query);
      errors.push(...await metricRefErrors(tenantId, query));
      validateVisualization({ type: widget.type, query, visualization: widget.visualization });
    } catch (e) { push(e); }
  }
  return { widgetId: String(widget._id), name: widget.name, errors };
}

/** Throw 400 DASHBOARD_PUBLISH_INVALID with per-widget errors unless publishable. */
export async function assertPublishable(tenantId, dashboardId) {
  // Validate the dashboard and every widget before it goes live.
  const { docs: widgets } = await widgetRepository.list({ tenantId, dashboardId, page: 1, limit: MAX_WIDGETS_PER_DASHBOARD });
  if (!widgets.length) {
    throw new ApiError(400, 'Add at least one widget before publishing', {
      code: 'DASHBOARD_PUBLISH_INVALID', errors: [{ field: 'widgets', message: 'Dashboard has no widgets' }],
    });
  }
  const checks = [];
  for (const w of widgets) checks.push(await validateWidgetForPublish(tenantId, w));
  const failing = checks.filter((c) => c.errors.length);
  if (failing.length) {
    throw new ApiError(400, `${failing.length} widget(s) must be fixed before publishing`, {
      code: 'DASHBOARD_PUBLISH_INVALID',
      errors: failing.flatMap((w) => w.errors.map((e) => ({
        field: `widgets.${w.widgetId}${e.field ? `.${e.field}` : ''}`,
        message: `${w.name}: ${e.message}`,
        widgetId: w.widgetId,
        widgetName: w.name,
      }))),
    });
  }
}

/* ------------------------------ dashboards -------------------------------- */

/** Paginated, tenant-scoped dashboard list (optional status/search filter). */
export async function listDashboards({ tenantId, page = 1, limit = 20, status, search, access } = {}) {
  const filter = { ...visibleFilter(access) };
  if (status && DASHBOARD_STATUSES.includes(status)) filter.status = status;
  if (search && typeof search === 'string' && search.trim()) {
    filter.name = { $regex: escapeRegExp(search.trim()), $options: 'i' };
  }
  return dashboardRepository.list({ tenantId, filter, page, limit });
}

/** Create a dashboard (draft by default). */
export async function createDashboard({ tenantId, actorId = null, name, description = '', layout, filters, refresh } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw ApiError.badRequest('dashboard name is required');
  const data = {
    tenantId,
    name: name.trim(),
    description: description ?? '',
    layout: sanitizeLayout(layout),
    filters: filters !== undefined ? sanitizeFilters(filters) : null,
    refresh: refresh !== undefined ? sanitizeRefresh(refresh) : { enabled: false, intervalSec: 300 },
    createdBy: actorId,
  };
  // Dashboard-count quota: consumed atomically, given back if the create fails.
  const saved = await usageService.withQuota({ tenantId, metric: 'dashboards', by: actorId }, () => dashboardRepository.create(data));
  await audit({
    tenantId, actorId, action: 'dashboard.created', resourceId: String(saved._id),
    after: { name: saved.name, status: saved.status },
  });
  return saved;
}

/** Fetch a dashboard (optionally with its widgets). */
export async function getDashboard({ tenantId, dashboardId, includeWidgets = false, access } = {}) {
  const found = await dashboardRepository.findById(dashboardId, { tenantId });
  if (!found) throw ApiError.notFound('Dashboard not found');
  const level = requireAccess(found, access, 'view');
  // Share entries are visible to managers only.
  const dashboard = { ...found, access: level, ...(level === 'manage' ? {} : { shares: undefined }) };
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
export async function updateDashboard({ tenantId, dashboardId, actorId = null, access, patch = {} } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'edit');
  // Updating a dashboard does not create one: no `dashboards` quota use.
  const updates = sanitizeDashboardPatch(patch);
  if (updates.visibility !== undefined) requireAccess(dashboard, access, 'manage');
  // Publishing through a status patch gets the same validation as /publish.
  if (updates.status === 'published' && dashboard.status !== 'published') {
    if (dashboard.status !== 'draft') throw ApiError.badRequest(`only draft dashboards can be published (current: ${dashboard.status})`);
    await assertPublishable(tenantId, dashboardId);
  }
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
export async function publishDashboard({ tenantId, dashboardId, actorId = null, access } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'edit');
  if (dashboard.status === 'published') return dashboard;
  if (dashboard.status !== 'draft') {
    throw ApiError.badRequest(`only draft dashboards can be published (current: ${dashboard.status})`);
  }
  await assertPublishable(tenantId, dashboardId);
  const updated = await dashboardRepository.update(dashboardId, { status: 'published', updatedBy: actorId });
  if (!updated) throw ApiError.notFound('Dashboard not found');
  await audit({
    tenantId, actorId, action: 'dashboard.published', resourceId: dashboardId,
    before: { status: 'draft' }, after: { status: 'published' },
  });
  return updated;
}

/** Duplicate a dashboard and all of its widgets (copy is a fresh draft). */
export async function duplicateDashboard({ tenantId, dashboardId, actorId = null, access } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'view');
  const widgets = await widgetRepository.list({ tenantId, dashboardId, page: 1, limit: MAX_WIDGETS_PER_DASHBOARD });
  // A duplicate is a new dashboard, so it counts against the quota.
  const copy = await usageService.withQuota({ tenantId, metric: 'dashboards', by: actorId }, () => dashboardRepository.create({
    tenantId,
    name: `${dashboard.name} (copy)`,
    description: dashboard.description ?? '',
    status: 'draft',
    layout: dashboard.layout ?? { columns: 12, rowHeight: 80 },
    filters: dashboard.filters ?? null,
    refresh: dashboard.refresh ?? { enabled: false, intervalSec: 300 },
    shares: [],
    createdBy: actorId,
  }));
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
export async function deleteDashboard({ tenantId, dashboardId, actorId = null, access } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'manage');
  if (!(await dashboardRepository.remove(dashboardId, actorId))) throw ApiError.notFound('Dashboard not found');
  await widgetRepository.softDeleteByDashboard(dashboardId, actorId);
  // Deleting a dashboard frees one unit of the `dashboards` quota.
  await usageService.release({ tenantId, metric: 'dashboards', requested: 1, by: actorId });
  await audit({ tenantId, actorId, action: 'dashboard.deleted', resourceId: dashboardId });
  return true;
}

/* ------------------------------ sharing ----------------------------------- */

/** Verify a share principal (tenant user or tenant role) exists. */
async function assertPrincipal(tenantId, principalType, principalId) {
  if (!SHARE_PRINCIPALS.includes(principalType)) throw ApiError.badRequest(`principalType must be one of ${SHARE_PRINCIPALS.join(', ')}`);
  const id = String(principalId ?? '');
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw ApiError.badRequest('principalId must be an id');
  const found = principalType === 'user'
    ? await User.exists({ _id: id, tenantId, deletedAt: null })
    : await Role.exists({ _id: id, tenantId });
  if (!found) throw ApiError.badRequest(`${principalType} not found in this workspace`);
  return id;
}

/**
 * List share grants (managers only) with display names, plus the tenant's
 * users and roles the manager can share with (first 200 of each).
 */
export async function listShares({ tenantId, dashboardId, access } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'manage');
  const [users, roles] = await Promise.all([
    User.find({ tenantId, deletedAt: null, status: 'active' }).select('email profile.name').limit(200).lean(),
    Role.find({ tenantId }).select('name').limit(200).lean(),
  ]);
  const userList = users.map((u) => ({ id: String(u._id), name: u.profile?.name ?? u.email, email: u.email }));
  const roleList = roles.map((r) => ({ id: String(r._id), name: r.name }));
  const nameOf = (s) => (s.principalType === 'user'
    ? userList.find((u) => u.id === s.principalId)?.email
    : roleList.find((r) => r.id === s.principalId)?.name) ?? s.principalId;
  return {
    visibility: dashboard.visibility ?? 'workspace',
    shares: (dashboard.shares ?? []).map((s) => ({ ...s, principalName: nameOf(s) })),
    candidates: { users: userList, roles: roleList },
  };
}

/**
 * Grant (or change) a share on a dashboard for a tenant user or role at
 * `view` or `edit` level. Only the owner or a `dashboards.assign` holder
 * manages shares. Shares matter once the dashboard is `restricted`.
 */
export async function shareDashboard({ tenantId, dashboardId, actorId = null, access, principalType, principalId, level = 'view' } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'manage');
  if (!SHARE_LEVELS.includes(level)) throw ApiError.badRequest(`level must be one of ${SHARE_LEVELS.join(', ')}`);
  const id = await assertPrincipal(tenantId, principalType, principalId);
  if (dashboard.shares?.some((s) => s.principalType === principalType && s.principalId === id)) {
    throw ApiError.conflict(`this ${principalType} already has access to this dashboard`);
  }
  const share = { principalType, principalId: id, level, createdBy: actorId, createdAt: new Date() };
  const updated = await dashboardRepository.addShare(dashboardId, share);
  if (!updated) throw ApiError.notFound('Dashboard not found');
  const added = updated.shares?.[updated.shares.length - 1] ?? share;
  await audit({
    tenantId, actorId, action: 'dashboard.shared', resourceId: dashboardId,
    after: { principalType, principalId: id, level },
  });
  return added;
}

/** Revoke a share grant by its sub-document id. */
export async function revokeShare({ tenantId, dashboardId, actorId = null, access, shareId } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'manage');
  const existing = dashboard.shares?.find((s) => String(s._id) === String(shareId));
  if (!existing) throw ApiError.notFound('Share entry not found');
  const updated = await dashboardRepository.removeShare(dashboardId, shareId);
  if (!updated) throw ApiError.notFound('Dashboard not found');
  await audit({
    tenantId, actorId, action: 'dashboard.share_revoked', resourceId: dashboardId,
    before: { principalType: existing.principalType, principalId: existing.principalId, level: existing.level },
  });
  return true;
}

/* ------------------------------- widgets ---------------------------------- */

/** Paginated widget list for a dashboard. */
export async function listWidgets({ tenantId, dashboardId, page = 1, limit = 50, access } = {}) {
  await loadDashboard(tenantId, dashboardId, access, 'view');
  return widgetRepository.list({ tenantId, dashboardId, page, limit });
}

/** Create a widget on a dashboard (dataset must be tenant-owned). */
export async function createWidget({ tenantId, dashboardId, actorId = null, data = {}, access } = {}) {
  await loadDashboard(tenantId, dashboardId, access, 'edit');
  if (typeof data.name !== 'string' || !data.name.trim()) throw ApiError.badRequest('widget name is required');
  if (!WIDGET_TYPES.includes(data.type)) throw ApiError.badRequest(`widget type must be one of ${WIDGET_TYPES.join(', ')}`);
  await assertDatasetOwned(tenantId, data.datasetId);
  // vizbuilder: reject invalid queries / visualization specs at save time.
  const query = sanitizeWidgetQuery(data.query);
  await assertQueryMatchesSchema(tenantId, data.datasetId, query);
  await assertMetricRefsActive(tenantId, query);
  const visualization = validateVisualization({ type: data.type, query, visualization: data.visualization });
  // Enforce per-dashboard widget limit (separate from overall dashboard quota).
  const count = await widgetRepository.countByDashboard(dashboardId);
  if (count >= MAX_WIDGETS_PER_DASHBOARD) {
    throw ApiError.conflict(`dashboard supports at most ${MAX_WIDGETS_PER_DASHBOARD} widgets`);
  }
  // Adding a widget does not create a dashboard: no `dashboards` quota use
  // (the per-dashboard widget cap above bounds widgets).
  const position = data.position
    ? sanitizePosition(data.position)
    : nextWidgetPosition(
      (await widgetRepository.list({ tenantId, dashboardId, page: 1, limit: MAX_WIDGETS_PER_DASHBOARD })).docs,
      data.type,
    );
  const saved = await widgetRepository.create({
    tenantId,
    dashboardId,
    name: data.name.trim(),
    type: data.type,
    datasetId: data.datasetId,
    query,
    visualization,
    position,
    createdBy: actorId,
  });
  await audit({
    tenantId, actorId, action: 'widget.created', resourceId: String(saved._id),
    after: { dashboardId: String(dashboardId), name: saved.name, type: saved.type },
  });
  return saved;
}

/** Fetch a single widget (scoped by tenant + dashboard). */
export async function getWidget({ tenantId, dashboardId, widgetId, access } = {}) {
  await loadDashboard(tenantId, dashboardId, access, 'view');
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  return widget;
}

/** Update a widget (whitelisted fields only; dataset re-verified when changed). */
export async function updateWidget({ tenantId, dashboardId, widgetId, actorId = null, patch = {}, access } = {}) {
  await loadDashboard(tenantId, dashboardId, access, 'edit');
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  const updates = sanitizeWidgetPatch(patch);
  if (updates.datasetId !== undefined) await assertDatasetOwned(tenantId, updates.datasetId);
  // vizbuilder: the saved combination (type + query + visualization) must be valid.
  if (['type', 'query', 'visualization', 'datasetId'].some((k) => updates[k] !== undefined)) {
    const type = updates.type ?? widget.type;
    const query = updates.query !== undefined ? updates.query : widget.query;
    if (updates.query !== undefined || updates.datasetId !== undefined) {
      await assertQueryMatchesSchema(tenantId, updates.datasetId ?? widget.datasetId, query);
      await assertMetricRefsActive(tenantId, query);
    }
    updates.visualization = validateVisualization({
      type, query, visualization: updates.visualization !== undefined ? updates.visualization : widget.visualization,
    });
  }
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
export async function removeWidget({ tenantId, dashboardId, widgetId, actorId = null, access } = {}) {
  await loadDashboard(tenantId, dashboardId, access, 'edit');
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
export async function executeWidget({ tenantId, dashboardId, widgetId, overrides = {}, actorId = null, actorType = null, page, limit, access } = {}) {
  // View-time overrides are a filter envelope: validated strictly up front.
  const cleanOverrides = Object.fromEntries(Object.entries(asObject(overrides)).filter(([, v]) => v !== undefined));
  const envelope = Object.keys(cleanOverrides).length ? sanitizeFilterEnvelope(cleanOverrides, '') : null;

  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'view');
  const widget = await widgetRepository.findById(widgetId, { tenantId, dashboardId });
  if (!widget) throw ApiError.notFound('Widget not found');
  const connector = await assertDatasetOwned(tenantId, widget.datasetId);

  const params = applyFilterEnvelope(mergeWidgetQuery({ widget, dashboard }), envelope);
  // vizbuilder: the spec drives paging (tables) and top N (bar/pie).
  const viz = resolveVisualization({ type: widget.type, query: widget.query, visualization: widget.visualization });
  const topN = applyTopN(params, viz);
  if (!topN && (page !== undefined || limit !== undefined || viz.pageSize)) {
    params.pagination = {
      ...params.pagination,
      ...(page !== undefined ? { page: clampInt(page, 1, 1, 100000) } : {}),
      ...(limit !== undefined || viz.pageSize ? { limit: clampInt(limit ?? viz.pageSize, 50, 1, 200) } : {}),
    };
  }
  // Execution keys go last so nothing in the stored query can replace them.
  const { options: prepared, window } = await engine.prepareQuery({
    ...params,
    tenantId,
    connectorIds: [String(widget.datasetId)],
  });
  const cacheKey = buildWidgetCacheKey({ tenantId, widget, dashboard, prepared, connector });

  const startedAt = Date.now();
  const { result, cached } = await analyticsCache.cachedQuery(
    cacheKey,
    () => runWithTopN(prepared, { ...params, tenantId, connectorIds: [String(widget.datasetId)] }, topN, viz),
    WIDGET_CACHE_TTL_SEC,
  );
  // ai-catalogue: a computed (not cached) run records its attribution.
  if (!cached) {
    await recordRun({
      tenantId,
      source: 'widget',
      sourceId: String(widget._id),
      actorType,
      actorId,
      prepared,
      window,
      dataVersions: [{ id: String(connector._id), version: connector.dataVersion ?? 0 }],
      result,
      durationMs: Date.now() - startedAt,
    });
  }

  const withPreset = engine.withRequestedPreset(result, params.dateRange);
  return {
    widgetId: String(widget._id),
    name: widget.name,
    type: widget.type,
    datasetId: String(widget.datasetId),
    cached,
    cacheKey,
    result: {
      ...withPreset,
      visualization: viz,
      provenance: buildProvenance({ widget, connector, result: withPreset, params, cached }),
    },
  };
}

/* ---------------------- vizbuilder: top N + provenance --------------------- */

/** Metric ops whose totals are additive (an "Other" bucket = total - top N). */
const ADDITIVE_OPS = new Set(['count', 'sum', 'count_non_null']);

/** For bar/pie specs with `limit`: order by the first measure and fetch the top N. */
function applyTopN(params, viz) {
  if (!viz.limit || !['bar', 'pie', 'doughnut'].includes(viz.type) || !viz.xField || !viz.measures.length) return null;
  const direction = viz.sort?.by === 'measure' && viz.sort.direction === 'asc' ? 'asc' : 'desc';
  params.orderBy = [{ field: viz.measures[0], direction }];
  params.pagination = { page: 1, limit: viz.limit };
  return { limit: viz.limit, showOther: viz.showOther };
}

/** Run the query; with top N, also compute "top N of M" and the Other bucket. */
async function runWithTopN(prepared, params, topN, viz) {
  const result = await engine.queryRows(prepared);
  if (!topN) return result;
  if (viz.sort?.by === 'dimension') {
    const dir = viz.sort.direction === 'desc' ? -1 : 1;
    result.rows.sort((a, b) => (a[viz.xField] > b[viz.xField] ? dir : a[viz.xField] < b[viz.xField] ? -dir : 0));
  }
  const info = { limit: topN.limit, of: result.total, other: null };
  if (topN.showOther && result.total > topN.limit) {
    const metrics = Array.isArray(params.metrics) && params.metrics.length ? params.metrics : [{ op: 'count' }];
    const { options: totalsQuery } = await engine.prepareQuery({ ...params, groupBy: [], orderBy: [], pagination: {}, metrics });
    const totals = (await engine.queryRows(totalsQuery)).rows[0] ?? {};
    const other = { [viz.xField]: 'Other' };
    for (const m of metrics) {
      const alias = engine.metricAlias(m);
      other[alias] = ADDITIVE_OPS.has(m.op)
        ? (Number(totals[alias]) || 0) - result.rows.reduce((acc, r) => acc + (Number(r[alias]) || 0), 0)
        : null;
    }
    info.other = other;
    result.rows = [...result.rows, { ...other, __other: true }];
  }
  result.topN = info;
  return result;
}

/** "How this was calculated": data window, zone, dataset freshness, query summary. */
function buildProvenance({ widget, connector, result, params, cached }) {
  const metrics = (params.metrics ?? []).map((m) => ({ op: m.op, field: m.field ?? null, alias: engine.metricAlias(m) }));
  return {
    window: result.window ?? null,
    timezone: result.timezone ?? null,
    dataset: {
      id: String(connector._id),
      name: connector.name ?? null,
      type: connector.type ?? null,
      dataVersion: connector.dataVersion ?? 0,
      lastSyncedAt: connector.lastSyncedAt ?? null,
    },
    metrics,
    groupBy: (params.groupBy ?? []).map((g) => (typeof g === 'string' ? { field: g, bucket: null } : { field: g.field, bucket: g.bucket ?? null })),
    filterCount: (params.filters ?? []).length + (params.filterGroups ?? []).reduce((n, g) => n + g.filters.length, 0),
    excluded: result.excluded ?? {},
    // DEPENDS(ai-catalogue): metric definitions are attached once MetricDefinition exists.
    metricDefinitions: [],
    executedAt: result.executedAt ?? null,
    cached: Boolean(cached),
    widgetUpdatedAt: widget.updatedAt ?? null,
  };
}


/**
 * Execute every widget on a dashboard. Partial failures are allowed: a
 * broken widget must not take down the whole dashboard view.
 */
export async function viewDashboard({ tenantId, dashboardId, actorId = null, actorType = null, access } = {}) {
  const dashboard = await loadDashboard(tenantId, dashboardId, access, 'view');
  const widgets = await widgetRepository.list({
    tenantId,
    dashboardId,
    page: 1,
    limit: MAX_WIDGETS_EXECUTED_PER_REQUEST,
  });

  // Bounded fan-out: one view never queues more than VIEW_CONCURRENCY
  // aggregations against the tenant's analytics concurrency limit.
  const settled = await settleWithConcurrency(
    widgets.docs,
    VIEW_CONCURRENCY,
    (w) => executeWidget({ tenantId, dashboardId, widgetId: String(w._id), actorId, actorType, access }),
  );

  // Each entry carries the engine result directly (`result.rows`, …), the
  // same shape as the single-widget execute endpoint and the frontend's
  // DashboardExecutionEntry contract.
  const results = settled.map((r, i) => {
    const w = widgets.docs[i];
    if (r.status === 'fulfilled') {
      return {
        widgetId: String(w._id),
        name: w.name,
        type: w.type,
        status: 'ok',
        cached: r.value.cached,
        result: r.value.result,
      };
    }
    return {
      widgetId: String(w._id),
      name: w.name,
      type: w.type,
      status: 'error',
      error: {
        message: r.reason?.message ?? 'Widget execution failed',
        code: r.reason?.code,
        ...(Array.isArray(r.reason?.errors) && r.reason.errors.length ? { errors: r.reason.errors } : {}),
      },
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
  listShares,
  accessContext,
  accessLevel,
  listWidgets,
  createWidget,
  getWidget,
  updateWidget,
  removeWidget,
  executeWidget,
  viewDashboard,
  mergeWidgetQuery,
  applyFilterEnvelope,
  sanitizeFilterEnvelope,
  _meta: { module: 'dashboards', cacheTtlSec: WIDGET_CACHE_TTL_SEC },
};
