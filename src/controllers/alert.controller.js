/**
 * Alert Controller (Sprint 7 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/alerts`. Translates request context (tenant,
 *   actor) into `alert.service` calls and shapes responses with
 *   `ApiResponse`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import alertService from '../services/alert.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;
const pageOf = (v, f = 1) => Math.max(1, Number(v) || f);
const limitOf = (v, f = 20, m = 100) => Math.min(Math.max(1, Number(v) || f), m);

/** GET /api/v1/alerts - paginated, tenant-scoped rule list. */
export const listAlerts = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await alertService.listRules({
    tenantId, page: pageOf(q.page), limit: limitOf(q.limit),
    enabled: q.enabled === undefined ? undefined : q.enabled === 'true' || q.enabled === true,
  });
  return ApiResponse.ok(res, result.docs, 'Alerts', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** POST /api/v1/alerts - create. */
export const createAlert = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const body = req.validated?.body ?? {};
  const rule = await alertService.createRule({ tenantId, actorId: actorOf(req), ...body });
  return ApiResponse.created(res, rule, 'Alert created');
});

/** GET /api/v1/alerts/:id - rule detail. */
export const getAlert = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const rule = await alertService.getById({ tenantId, alertId: req.validated.params.id });
  return ApiResponse.ok(res, rule, 'Alert');
});

/** PATCH /api/v1/alerts/:id - update. */
export const updateAlert = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const rule = await alertService.updateRule({
    tenantId, alertId: req.validated.params.id, actorId: actorOf(req), patch: req.validated.body,
  });
  return ApiResponse.ok(res, rule, 'Alert updated');
});

/** DELETE /api/v1/alerts/:id - soft-delete. */
export const deleteAlert = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await alertService.removeRule({ tenantId, alertId: req.validated.params.id, actorId: actorOf(req) });
  return ApiResponse.noContent(res);
});

/** POST /api/v1/alerts/:id/evaluate - manual evaluation. */
export const evaluateAlert = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const result = await alertService.evaluate({
    tenantId, alertId: req.validated.params.id, triggeredBy: 'manual', runBy: actorOf(req),
  });
  return ApiResponse.ok(res, result, 'Alert evaluated');
});

/** GET /api/v1/alerts/:id/events - evaluation events for one alert. */
export const listAlertEvents = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await alertService.listEvents({
    tenantId, alertId: req.validated.params.id, page: pageOf(q.page), limit: limitOf(q.limit),
  });
  return ApiResponse.ok(res, result.docs, 'Alert events', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** GET /api/v1/alerts/events - all evaluation events for the tenant. */
export const listAllEvents = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await alertService.listEvents({
    tenantId, page: pageOf(q.page), limit: limitOf(q.limit),
  });
  return ApiResponse.ok(res, result.docs, 'Alert events', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

export default {
  listAlerts, createAlert, getAlert, updateAlert, deleteAlert, evaluateAlert,
  listAlertEvents, listAllEvents,
};
