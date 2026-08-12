/**
 * Report Controller (Sprint 7 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/reports`. Translates request context (tenant,
 *   actor) into `report.service` calls and shapes responses with
 *   `ApiResponse`. Ad-hoc runs return 202 Accepted because generation is
 *   enqueued onto the analytics queue.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import reportService from '../services/report.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;
const pageOf = (v, f = 1) => Math.max(1, Number(v) || f);
const limitOf = (v, f = 20, m = 100) => Math.min(Math.max(1, Number(v) || f), m);

/** GET /api/v1/reports - paginated, tenant-scoped list. */
export const listReports = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await reportService.list({
    tenantId, page: pageOf(q.page), limit: limitOf(q.limit), status: q.status, search: q.search,
  });
  return ApiResponse.ok(res, result.docs, 'Reports', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** POST /api/v1/reports - create. */
export const createReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const body = req.validated?.body ?? {};
  const report = await reportService.create({ tenantId, actorId: actorOf(req), ...body });
  return ApiResponse.created(res, report, 'Report created');
});

/** GET /api/v1/reports/:id - detail (includes run history). */
export const getReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const report = await reportService.getById({ tenantId, reportId: req.validated.params.id });
  return ApiResponse.ok(res, report, 'Report');
});

/** PATCH /api/v1/reports/:id - update. */
export const updateReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const report = await reportService.update({
    tenantId, reportId: req.validated.params.id, actorId: actorOf(req), patch: req.validated.body,
  });
  return ApiResponse.ok(res, report, 'Report updated');
});

/** POST /api/v1/reports/:id/run - enqueue an ad-hoc run. */
export const runReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const body = req.validated?.body ?? {};
  const result = await reportService.run({
    tenantId, reportId: req.validated.params.id, actorId: actorOf(req),
    format: body.format, filters: body.filters,
  });
  return ApiResponse.accepted(res, result, 'Report run accepted');
});

/** DELETE /api/v1/reports/:id - soft-delete. */
export const deleteReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await reportService.remove({ tenantId, reportId: req.validated.params.id, actorId: actorOf(req) });
  return ApiResponse.noContent(res);
});

/** GET /api/v1/reports/:id/download - latest (or specific) artefact URL. */
export const downloadReport = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const descriptor = await reportService.download({
    tenantId, reportId: req.validated.params.id, runId: q.runId,
  });
  return ApiResponse.ok(res, descriptor, 'Download');
});

export default {
  listReports, createReport, getReport, updateReport, runReport, deleteReport, downloadReport,
};
