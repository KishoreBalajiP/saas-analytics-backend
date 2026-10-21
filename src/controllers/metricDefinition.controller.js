/**
 * Metric definition controller (ai-catalogue).
 *
 * HTTP layer for `/api/v1/metrics`: tenant and actor from the request,
 * one service call, the standard envelope. Bodies are forwarded as given
 * (only the keys the route validator knows) so the service can report
 * every definition problem with its field name.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import metricService from '../services/metricDefinition.service.js';

const actorOf = (req) => req.user?.id ?? null;
const DEFINITION_KEYS = [
  'key', 'label', 'description', 'connectorId', 'aggregation', 'field', 'numerator', 'denominator',
  'filters', 'unit', 'format', 'direction', 'owner',
];
/** The raw body restricted to definition keys (null values kept: they clear a field). */
const definitionOf = (body = {}) => Object.fromEntries(
  Object.entries(body && typeof body === 'object' ? body : {}).filter(([k]) => DEFINITION_KEYS.includes(k)),
);

/** GET /api/v1/metrics - catalogue (latest version per key). */
export const listMetrics = asyncHandler(async (req, res) => {
  const q = req.validated?.query ?? {};
  const result = await metricService.list({
    tenantId: getTenantId(req), status: q.status, search: q.search, connectorId: q.connectorId,
    page: q.page ?? 1, limit: q.limit ?? 50,
  });
  return ApiResponse.ok(res, result.docs, 'Metrics', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** POST /api/v1/metrics - create a draft (version 1). */
export const createMetric = asyncHandler(async (req, res) => {
  const metric = await metricService.create({ tenantId: getTenantId(req), actorId: actorOf(req), input: definitionOf(req.body) });
  return ApiResponse.created(res, metric, 'Metric created');
});

/** POST /api/v1/metrics/suggest - profiler drafts for one dataset. */
export const suggestMetrics = asyncHandler(async (req, res) => {
  const result = await metricService.suggest({
    tenantId: getTenantId(req), actorId: actorOf(req), connectorId: req.validated.body.connectorId,
  });
  return ApiResponse.created(res, result, 'Metric suggestions');
});

/** GET /api/v1/metrics/:key - one version (latest by default) with the version list. */
export const getMetric = asyncHandler(async (req, res) => {
  const metric = await metricService.get({
    tenantId: getTenantId(req), key: req.validated.params.key, version: req.validated.query?.version,
  });
  return ApiResponse.ok(res, metric, 'Metric');
});

/** PATCH /api/v1/metrics/:key - edit: saves the next version as a draft. */
export const updateMetric = asyncHandler(async (req, res) => {
  const metric = await metricService.update({
    tenantId: getTenantId(req), key: req.validated.params.key, actorId: actorOf(req), patch: definitionOf(req.body),
  });
  return ApiResponse.created(res, metric, 'Metric version created');
});

/** POST /api/v1/metrics/:key/versions/:version/approve - approve a draft version. */
export const approveMetric = asyncHandler(async (req, res) => {
  const metric = await metricService.approve({
    tenantId: getTenantId(req), key: req.validated.params.key, version: req.validated.params.version, actorId: actorOf(req),
  });
  return ApiResponse.ok(res, metric, 'Metric approved');
});

/** DELETE /api/v1/metrics/:key - archive every version. */
export const archiveMetric = asyncHandler(async (req, res) => {
  const result = await metricService.archive({ tenantId: getTenantId(req), key: req.validated.params.key, actorId: actorOf(req) });
  return ApiResponse.ok(res, result, 'Metric archived');
});

export default { listMetrics, createMetric, suggestMetrics, getMetric, updateMetric, approveMetric, archiveMetric };
