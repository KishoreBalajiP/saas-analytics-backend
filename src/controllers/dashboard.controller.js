/**
 * Dashboard Controller (Sprint 6 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/dashboards`. Wires tenant-scoped dashboard +
 *   widget CRUD, sharing, and widget analytics execution to the dashboard
 *   service. Keeps the routes file free of logic.
 *
 * RESPONSIBILITY
 *   Translate request context (tenant, actor) into service calls and shape
 *   responses with `ApiResponse`. Never touches repositories directly.
 *
 * CODING GUIDELINES
 *   - Always resolve `req.tenant.id`; a missing tenant fails closed in the
 *     tenant middleware before these handlers run.
 *   - Widget-execute overrides arrive as JSON-encoded query parameters and
 *     are parsed here (mirroring the analytics controller).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import dashboardService from '../services/dashboard.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** Parse a JSON-encoded query parameter, returning `undefined` when absent. */
function parseJsonParam(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw ApiError.badRequest(`${field} must be a valid JSON string`);
  }
}

const pageOf = (value, fallback = 1) => Math.max(1, Number(value) || fallback);
const limitOf = (value, fallback = 20, max = 100) => Math.min(Math.max(1, Number(value) || fallback), max);

/* ------------------------------ dashboards -------------------------------- */

/** GET /api/v1/dashboards - paginated, tenant-scoped list. */
export const listDashboards = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await dashboardService.listDashboards({
    tenantId,
    page: pageOf(q.page),
    limit: limitOf(q.limit, 20, 100),
    status: q.status,
    search: q.search,
  });
  return ApiResponse.ok(res, result.docs, 'Dashboards', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /api/v1/dashboards - create (draft by default). */
export const createDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const body = req.validated?.body ?? {};
  const dashboard = await dashboardService.createDashboard({
    tenantId,
    actorId: actorOf(req),
    name: body.name,
    description: body.description,
    layout: body.layout,
    filters: body.filters,
    refresh: body.refresh,
  });
  return ApiResponse.created(res, dashboard, 'Dashboard created');
});

/** GET /api/v1/dashboards/:id - detail (with its widgets by default). */
export const getDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const includeWidgets = req.query.includeWidgets === undefined || req.query.includeWidgets !== 'false';
  const { dashboard, widgets } = await dashboardService.getDashboard({
    tenantId,
    dashboardId: req.params.id,
    includeWidgets,
  });
  return ApiResponse.ok(res, includeWidgets ? { ...dashboard, widgets } : dashboard, 'Dashboard');
});

/** PATCH /api/v1/dashboards/:id - update (whitelisted fields). */
export const updateDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const dashboard = await dashboardService.updateDashboard({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
    patch: req.validated?.body ?? req.body ?? {},
  });
  return ApiResponse.ok(res, dashboard, 'Dashboard updated');
});

/** POST /api/v1/dashboards/:id/publish - publish a draft. */
export const publishDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const dashboard = await dashboardService.publishDashboard({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
  });
  return ApiResponse.ok(res, dashboard, 'Dashboard published');
});

/** POST /api/v1/dashboards/:id/duplicate - copy dashboard + widgets. */
export const duplicateDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const copy = await dashboardService.duplicateDashboard({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
  });
  return ApiResponse.created(res, copy, 'Dashboard duplicated');
});

/** POST /api/v1/dashboards/:id/share - grant a revocable email share. */
export const shareDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const body = req.validated?.body ?? {};
  const share = await dashboardService.shareDashboard({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
    email: body.email,
    role: body.role,
    expiresAt: body.expiresAt,
  });
  return ApiResponse.created(res, share, 'Dashboard shared');
});

/** DELETE /api/v1/dashboards/:id/share/:entryId - revoke a share grant. */
export const revokeShare = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await dashboardService.revokeShare({
    tenantId,
    dashboardId: req.params.id,
    shareId: req.params.entryId,
    actorId: actorOf(req),
  });
  return ApiResponse.noContent(res);
});

/** DELETE /api/v1/dashboards/:id - soft-delete (cascades to widgets). */
export const deleteDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await dashboardService.deleteDashboard({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
  });
  return ApiResponse.noContent(res);
});

/* ------------------------------- widgets ---------------------------------- */

/** GET /api/v1/dashboards/:id/widgets - paginated widget list. */
export const listWidgets = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await dashboardService.listWidgets({
    tenantId,
    dashboardId: req.params.id,
    page: pageOf(q.page),
    limit: limitOf(q.limit, 50, 200),
  });
  return ApiResponse.ok(res, result.docs, 'Widgets', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /api/v1/dashboards/:id/widgets - create a widget. */
export const createWidget = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const widget = await dashboardService.createWidget({
    tenantId,
    dashboardId: req.params.id,
    actorId: actorOf(req),
    data: req.validated?.body ?? req.body ?? {},
  });
  return ApiResponse.created(res, widget, 'Widget created');
});

/** GET /api/v1/dashboards/:id/widgets/:widgetId - single widget. */
export const getWidget = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const widget = await dashboardService.getWidget({
    tenantId,
    dashboardId: req.params.id,
    widgetId: req.params.widgetId,
  });
  return ApiResponse.ok(res, widget, 'Widget');
});

/** PATCH /api/v1/dashboards/:id/widgets/:widgetId - update a widget. */
export const updateWidget = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const widget = await dashboardService.updateWidget({
    tenantId,
    dashboardId: req.params.id,
    widgetId: req.params.widgetId,
    actorId: actorOf(req),
    patch: req.validated?.body ?? req.body ?? {},
  });
  return ApiResponse.ok(res, widget, 'Widget updated');
});

/** DELETE /api/v1/dashboards/:id/widgets/:widgetId - soft-delete a widget. */
export const removeWidget = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await dashboardService.removeWidget({
    tenantId,
    dashboardId: req.params.id,
    widgetId: req.params.widgetId,
    actorId: actorOf(req),
  });
  return ApiResponse.noContent(res);
});

/* ------------------------------ execution --------------------------------- */

/** GET /api/v1/dashboards/:id/widgets/:widgetId/execute - run one widget. */
export const executeWidget = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const overrides = {
    dateRange: parseJsonParam(req.query.dateRange, 'dateRange'),
    filters: parseJsonParam(req.query.filters, 'filters'),
    filtersOp: typeof req.query.filtersOp === 'string' ? String(req.query.filtersOp) : undefined,
  };
  const result = await dashboardService.executeWidget({
    tenantId,
    dashboardId: req.params.id,
    widgetId: req.params.widgetId,
    overrides,
  });
  return ApiResponse.ok(res, result.result, 'Widget execution', {
    widgetId: result.widgetId,
    name: result.name,
    type: result.type,
    datasetId: result.datasetId,
    cached: result.cached,
    cacheKey: result.cacheKey,
  });
});

/** GET /api/v1/dashboards/:id/execute - run every widget (partial failures allowed). */
export const executeDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const result = await dashboardService.viewDashboard({
    tenantId,
    dashboardId: req.params.id,
  });
  return ApiResponse.ok(res, result.widgets, 'Dashboard execution', {
    dashboardId: String(result.dashboard._id),
    name: result.dashboard.name,
    widgetCount: result.widgets.length,
  });
});

export default {
  listDashboards,
  createDashboard,
  getDashboard,
  updateDashboard,
  publishDashboard,
  duplicateDashboard,
  shareDashboard,
  revokeShare,
  deleteDashboard,
  listWidgets,
  createWidget,
  getWidget,
  updateWidget,
  removeWidget,
  executeWidget,
  executeDashboard,
};
