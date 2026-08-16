/**
 * External API Controller (Sprint 9 - implemented).
 *
 * All endpoints are authenticated via X-Api-Key (middleware attaches
 * req.apiKey and req.tenant). Scopes are enforced by the middleware
 * factory or inline via externalApiService.requireScope.
 */

import externalApiService from '../services/externalApi.service.js';
import { validateQueryDataset, validateListDatasets, validateListDatasetRows } from '../validators/externalApi.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';

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
    return ApiResponse.ok(res, result);
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
    const { valid, errors } = validateQueryDataset(req.query);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    externalApiService.requireScope(req.apiKey, 'analytics:query');
    const result = await externalApiService.queryDataset({
      tenantId: req.tenant,
      datasetId: req.params.datasetId,
      query: {
        filters: req.query.filters ? JSON.parse(req.query.filters) : undefined,
        filtersOp: req.query.filtersOp,
        dateRange: req.query.dateRange ? JSON.parse(req.query.dateRange) : undefined,
        metrics: req.query.metrics ? JSON.parse(req.query.metrics) : undefined,
        groupBy: req.query.groupBy ? JSON.parse(req.query.groupBy) : undefined,
        orderBy: req.query.orderBy ? JSON.parse(req.query.orderBy) : undefined,
        pagination: req.query.pagination ? JSON.parse(req.query.pagination) : undefined,
      },
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
    return ApiResponse.ok(res, result);
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

export default { listDatasets, getDataset, queryDataset, listDatasetRows, getDashboard };