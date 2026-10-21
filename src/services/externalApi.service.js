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

// rls: dataset grants and row-level security.
import dataAccess from './dataAccess.service.js';
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
    // devapi: stable code for the external API.
    throw new ApiError(403, `Scope "${scope}" is required`, { code: 'INSUFFICIENT_SCOPE' });
  }
}

/** devapi: malformed ids are a typed 404, never a CastError 500. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/u;
function assertId(id, what) {
  if (!OBJECT_ID.test(String(id))) throw ApiError.notFound(`${what} not found`);
}

/** List connectors (datasets) the tenant owns. */
export async function listDatasets({ tenantId, page = 1, limit = 50 } = {}) {
  // rls: datasets hidden from the key's creator are not listed.
  const hidden = await dataAccess.hiddenConnectorIds(tenantId);
  const result = await connectorRepository.list({
    tenantId,
    filter: { status: 'active', ...(hidden.length ? { _id: { $nin: hidden } } : {}) },
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
  assertId(datasetId, 'Dataset');
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');
  // rls
  if ((await dataAccess.hiddenConnectorIds(tenantId)).includes(String(connector._id))) throw ApiError.notFound('Dataset not found');
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

/** Query keys an API caller may send (the dataset comes from the path). */
const EXTERNAL_QUERY_KEYS = Object.freeze(['filters', 'filtersOp', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'pagination']);

/**
 * Query a dataset (connector) via the analytics engine, under the same
 * strict contract as every other consumer: unknown or invalid parts are 400
 * INVALID_QUERY with field errors. Relative presets resolve in the
 * workspace time zone.
 * Returns the engine result { rows, total, page, pages, limit, columns,
 * executedAt, groupMode, timezone, window }.
 */
export async function queryDataset({ tenantId, datasetId, query = {} } = {}) {
  const validated = analyticsEngine.validateQuery(query, { keys: EXTERNAL_QUERY_KEYS });

  // Verify dataset exists and belongs to tenant.
  if (!/^[0-9a-fA-F]{24}$/.test(String(datasetId))) throw ApiError.notFound('Dataset not found');
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');

  return analyticsEngine.queryRows({ ...validated, tenantId, connectorIds: [String(connector._id)] });
}

/** List raw rows from a dataset (simple pagination, no aggregations). */
export async function listDatasetRows({ tenantId, datasetId, page = 1, limit = 100 } = {}) {
  assertId(datasetId, 'Dataset');
  const connector = await connectorRepository.findById(datasetId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');

  const connectorRowRepository = (await import('../repositories/connectorRow.repository.js')).default;
  // rls: dataset grants and row rules of the key's creator.
  const match = await dataAccess.rowListMatch({ tenantId, connectorId: datasetId });
  const result = await connectorRowRepository.list({ connectorId: datasetId, tenantId, page, limit, match });
  return result;
}

/** Get a published dashboard (read-only, no widgets execution). */
export async function getDashboard({ tenantId, dashboardId } = {}) {
  assertId(dashboardId, 'Dashboard');
  // getDashboard returns `{ dashboard }` and throws 404 when missing.
  const { dashboard } = await dashboardService.getDashboard({ tenantId, dashboardId });
  // Only published dashboards are visible via external API.
  if (!dashboard || dashboard.status !== 'published') throw ApiError.notFound('Dashboard not found');
  const { shares, createdBy, updatedBy, deletedAt, deletedBy, __v, ...publicFields } = dashboard;
  return publicFields;
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