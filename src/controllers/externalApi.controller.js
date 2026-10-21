/**
 * External API Controller (Sprint 9 - implemented).
 *
 * All endpoints are authenticated via X-Api-Key (middleware attaches
 * req.apiKey and req.tenant). Scopes are enforced by the middleware
 * factory or inline via externalApiService.requireScope.
 */

import externalApiService from '../services/externalApi.service.js';
import { validateListDatasets, validateListDatasetRows } from '../validators/externalApi.validator.js';
import { parseQueryString, EXTERNAL_QUERY_PARAMS } from '../validators/analytics.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
// devapi:
import apiKeyService from '../services/apiKey.service.js';
import { buildExternalApiSpec } from '../openapi/externalApi.spec.js';

/** GET /external/datasets */
export async function listDatasets(req, res, next) {
  try {
    const { valid, errors } = validateListDatasets(req.query);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    externalApiService.requireScope(req.apiKey, 'datasets:read');
    const result = await externalApiService.listDatasets({
      tenantId: req.tenant,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    // devapi: list envelope (array in data, pagination in meta).
    return ApiResponse.ok(res, result.docs, 'Listed', { page: result.page, limit: result.limit, total: result.total, pages: result.pages });
  } catch (err) {
    next(err);
  }
}

/** GET /external/datasets/:datasetId */
export async function getDataset(req, res, next) {
  try {
    externalApiService.requireScope(req.apiKey, 'datasets:read');
    const dataset = await externalApiService.getDataset({
      tenantId: req.tenant,
      datasetId: req.params.datasetId,
    });
    if (!dataset) return next(ApiError.notFound('Dataset not found'));
    return ApiResponse.ok(res, dataset);
  } catch (err) {
    next(err);
  }
}

/** GET /external/datasets/:datasetId/query */
export async function queryDataset(req, res, next) {
  try {
    externalApiService.requireScope(req.apiKey, 'analytics:query');
    // Strict: unknown parameters and malformed JSON are 400 INVALID_QUERY;
    // the engine contract then validates every part of the query.
    const query = parseQueryString(req.query, EXTERNAL_QUERY_PARAMS);
    const result = await externalApiService.queryDataset({
      tenantId: req.tenant,
      datasetId: req.params.datasetId,
      query,
    });
    return ApiResponse.ok(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /external/datasets/:datasetId/rows */
export async function listDatasetRows(req, res, next) {
  try {
    const { valid, errors } = validateListDatasetRows(req.query);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    externalApiService.requireScope(req.apiKey, 'analytics:query');
    const result = await externalApiService.listDatasetRows({
      tenantId: req.tenant,
      datasetId: req.params.datasetId,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 100,
    });
    return ApiResponse.ok(res, result.docs, 'Listed', { page: result.page, limit: result.limit, total: result.total, pages: result.pages });
  } catch (err) {
    next(err);
  }
}

/** GET /external/dashboards/:dashboardId */
export async function getDashboard(req, res, next) {
  try {
    externalApiService.requireScope(req.apiKey, 'dashboards:read');
    const dashboard = await externalApiService.getDashboard({
      tenantId: req.tenant,
      dashboardId: req.params.dashboardId,
    });
    if (!dashboard) return next(ApiError.notFound('Dashboard not found'));
    return ApiResponse.ok(res, dashboard);
  } catch (err) {
    next(err);
  }
}

/** devapi: DELETE /external/v1/keys/self - revoke the calling key. */
export async function revokeSelf(req, res, next) {
  try {
    await apiKeyService.revokeSelf({ tenantId: String(req.apiKey.tenantId), keyId: String(req.apiKey.keyId) });
    return ApiResponse.ok(res, { id: String(req.apiKey.keyId), revoked: true }, 'API key revoked');
  } catch (err) {
    next(err);
  }
}

/** devapi: GET /external/openapi.json - public OpenAPI 3.1 reference. */
export function openApiSpec(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(buildExternalApiSpec());
}

export default { listDatasets, getDataset, queryDataset, listDatasetRows, getDashboard, revokeSelf, openApiSpec };