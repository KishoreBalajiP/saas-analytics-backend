/**
 * External API Service (Sprint 9 - implemented).
 *
 * PURPOSE
 *   The business layer for the `X-Api-Key` authenticated surface. Scopes
 *   (`analytics:query`, `datasets:read`, `connectors:read`, `dashboards:read`)
 *   gate what callers can do. All calls are tenant-scoped via the
 *   authenticated key's tenantId.
 *
 * SCOPE MATRIX
 *   - analytics:query  → /datasets/:datasetId/query, /datasets/:datasetId/rows
 *   - datasets:read    → /datasets, /datasets/:datasetId
 *   - connectors:read  → /connectors (not exposed here; kept for future)
 *   - dashboards:read  → /dashboards/:dashboardId
 *
 * CODING GUIDELINES
 *   - All reads are tenant-scoped (key.tenantId injected by middleware).
 *   - Dataset = ConnectorRow bucket keyed by connectorId. The external API
 *     treats a connector as a "dataset" (back-compat with UI language).
 *   - Queries reuse `analytics.engine.queryRows` with `connectorIds:[id]`.
 *   - Dashboard reads reuse `dashboard.service.getDashboard` + `viewDashboard`
 *     (without write access).
 */

import analyticsEngine from './analytics.engine.js';
import connectorRepository from '../repositories/connector.repository.js';
import dashboardService from './dashboard.service.js';
import ApiError from '../utils/ApiError.js';

/** Map scope → allowed actions (for documentation + guard helpers). */
export const SCOPE_ACTIONS = Object.freeze({
  'analytics:query': ['queryDataset', 'listDatasetRows'],
  'datasets:read': ['listDatasets', 'getDataset'],
  'dashboards:read': ['getDashboard'],
});

/** Verify a key has the required scope (throws if not). */
export function requireScope(key, scope) {
  if (!key.scopes?.includes(scope)) {
    throw ApiError.forbidden(`Scope "${scope}" is required`);
  }
}

/** List connectors (datasets) the tenant owns. */
export async function listDatasets({ tenantId, page = 1, limit = 50 } = {}) {
  const result = await connectorRepository.list({
    tenantId,
    filter: { status: 'active' },
    page,
    limit,
  });
  return {
    ...result,
    docs: result.docs.map((c) => ({
      id: c._id,
      name: c.name,
      type: c.type,
      status: c.status,
      configSummary: c.configSummary,
      fieldMapping: c.fieldMapping,
      lastSyncedAt: c.lastSyncedAt,
      createdAt: c.createdAt,
    })),
  };
}

/** Get a single dataset (connector). */
export async function getDataset({ tenantId, datasetId } = {}) {
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');
  return {
    id: connector._id,
    name: connector.name,
    type: connector.type,
    status: connector.status,
    configSummary: connector.configSummary,
    fieldMapping: connector.fieldMapping,
    lastSyncedAt: connector.lastSyncedAt,
    createdAt: connector.createdAt,
  };
}

/**
 * Query a dataset (connector) via the analytics engine.
 * Returns the engine result { rows, total, page, pages, limit, columns, executedAt, groupMode }.
 */
export async function queryDataset({ tenantId, datasetId, query = {} } = {}) {
  // Verify dataset exists and belongs to tenant.
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');

  // Delegate to analytics engine with connector-scoped query.
  const engineQuery = {
    tenantId,
    connectorIds: [datasetId],
    filters: query.filters,
    filtersOp: query.filtersOp,
    dateRange: query.dateRange,
    metrics: query.metrics,
    groupBy: query.groupBy,
    orderBy: query.orderBy,
    pagination: query.pagination,
  };
  return analyticsEngine.queryRows(engineQuery);
}

/** List raw rows from a dataset (simple pagination, no aggregations). */
export async function listDatasetRows({ tenantId, datasetId, page = 1, limit = 100 } = {}) {
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');

  // Use connectorRowRepository list (connectorRow = ingested row).
  // Note: connectorRowRepository doesn't have a direct list method exposed
  // with connectorId+tenantId in this project. We'll use the engine with
  // count metric and no groupBy to get raw rows. Or use the existing
  // connectorRow list if available.
  // Let's use the analytics engine with a simple query: count per row (no groupBy)
  // returns each row as a "group" with count=1. Better: use connectorRowRepository.
  // Let me check - connectorRowRepository has list({connectorId, tenantId, page, limit}).
  // I'll import it.
  const connectorRowRepository = (await import('../repositories/connectorRow.repository.js')).default;
  const result = await connectorRowRepository.list({ connectorId: datasetId, tenantId, page, limit });
  return result;
}

/** Get a published dashboard (read-only, no widgets execution). */
export async function getDashboard({ tenantId, dashboardId } = {}) {
  const dashboard = await dashboardService.getDashboard({ tenantId, dashboardId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  // Only published dashboards are visible via external API.
  if (dashboard.status !== 'published') throw ApiError.notFound('Dashboard not found');
  return dashboard;
}

export default {
  listDatasets,
  getDataset,
  queryDataset,
  listDatasetRows,
  getDashboard,
  SCOPE_ACTIONS,
  requireScope,
};