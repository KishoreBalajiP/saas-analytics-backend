/**
 * Connector Controller (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   HTTP layer for `/api/v1/connectors`. Wires tenant-scoped CRUD, config
 *   validation, CSV preview + sync (file upload) and row listing to the
 *   connector service. Keeps the routes file free of logic.
 *
 * RESPONSIBILITY
 *   Translate request context (tenant, actor) into service calls and shape
 *   responses with `ApiResponse`. Never touches repositories directly.
 *
 * CODING GUIDELINES
 *   - Always resolve `req.tenant.id`; a missing tenant fails closed in the
 *     tenant middleware before these handlers run.
 *   - Errors are thrown as `ConnectorError` subclasses and formatted by the
 *     global error middleware.
 */

import ApiError from '../utils/ApiError.js';
// rls: hide restricted datasets from members without a grant.
import dataAccess from '../services/dataAccess.service.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import connectorService from '../services/connector.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** GET /api/v1/connectors/:connectorId/preview - generic file preview (CSV/XLSX). */
export const previewFile = asyncHandler(async (req, res) => {
  const result = await connectorService.previewFileUpload({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    buffer: req.file?.buffer,
    filename: req.file?.originalname ?? null,
    detectedType: req.file?.detectedType,
    limit: Number(req.body?.limit) || 10,
  });
  return ApiResponse.ok(res, result, 'File preview');
});

/**
 * POST /api/v1/connectors/file-preview - preview a CSV / XLSX before a
 * dataset exists (fields, first rows, XLSX sheet names). Nothing is stored.
 */
export const previewNewFile = asyncHandler(async (req, res) => {
  const result = await connectorService.previewUnsavedFile({
    buffer: req.file?.buffer,
    detectedType: req.file?.detectedType,
    fields: req.body ?? {},
    limit: Number(req.body?.limit) || 10,
  });
  return ApiResponse.ok(res, { ...result, filename: req.file?.originalname ?? null }, 'File preview');
});

/**
 * POST /api/v1/connectors/import - upload a CSV / XLSX as a new named
 * dataset: creates the connector and queues its import (202).
 */
export const importFile = asyncHandler(async (req, res) => {
  const result = await connectorService.importFileDataset({
    tenantId: getTenantId(req),
    actorId: actorOf(req),
    name: req.body?.name,
    buffer: req.file?.buffer,
    filename: req.file?.originalname ?? null,
    detectedType: req.file?.detectedType,
    fields: req.body ?? {},
  });
  return ApiResponse.accepted(res, result, 'Dataset created; import queued');
});

/** POST /api/v1/connectors/:connectorId/sync - generic file sync (CSV/XLSX). */
export const syncFile = asyncHandler(async (req, res) => {
  const result = await connectorService.syncFileUpload({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    actorId: actorOf(req),
    buffer: req.file?.buffer,
    filename: req.file?.originalname ?? null,
    detectedType: req.file?.detectedType,
  });
  return ApiResponse.accepted(res, result, 'File sync enqueued');
});

/** POST /api/v1/connectors/:connectorId/sync-mongodb - MongoDB pull-sync. */
export const syncMongoDB = asyncHandler(async (req, res) => {
  const result = await connectorService.syncMongoDB({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    actorId: actorOf(req),
  });
  return ApiResponse.accepted(res, result, 'MongoDB sync enqueued');
});

// datasets: GET /api/v1/connectors/:connectorId/schema - typed dataset schema.
export const getSchema = asyncHandler(async (req, res) => {
  const schema = await connectorService.getConnectorSchema({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
  });
  return ApiResponse.ok(res, schema, 'Dataset schema');
});

// datasets: POST /api/v1/connectors/:connectorId/schema/refresh - re-profile.
export const refreshSchema = asyncHandler(async (req, res) => {
  const schema = await connectorService.refreshConnectorSchema({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
  });
  return ApiResponse.ok(res, schema, 'Dataset schema refreshed');
});

// datasets: GET /api/v1/connectors/:connectorId/discover?database= - MongoDB source discovery.
export const discover = asyncHandler(async (req, res) => {
  const result = await connectorService.discoverMongoSources({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    database: typeof req.query.database === 'string' ? req.query.database : undefined,
  });
  return ApiResponse.ok(res, result, 'Source discovery');
});
/** GET /api/v1/connectors/types - registered connector catalogue. */
export const listTypes = asyncHandler(async (_req, res) => {
  return ApiResponse.ok(res, connectorService.listConnectorTypes(), 'Connector types');
});

/** GET /api/v1/connectors - paginated, tenant-scoped list. */
export const list = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const result = await connectorService.listConnectorRecords({
    tenantId,
    // rls: restricted datasets without a grant are not listed.
    excludeIds: await dataAccess.hiddenConnectorIds(tenantId),
    page: Number(req.query.page) || 1,
    limit: Math.min(Number(req.query.limit) || 20, 100),
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
  });
  return ApiResponse.ok(res, result.docs, 'Connectors', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /api/v1/connectors/:connectorId - detail. */
export const getById = asyncHandler(async (req, res) => {
  // rls: a restricted dataset without a grant does not exist for the caller.
  if ((await dataAccess.hiddenConnectorIds(getTenantId(req))).includes(String(req.params.connectorId))) {
    throw ApiError.notFound('Connector not found');
  }
  const connector = await connectorService.getConnectorRecord({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
  });
  return ApiResponse.ok(res, connector, 'Connector');
});

/** POST /api/v1/connectors - create (config validated + encrypted at rest). */
export const create = asyncHandler(async (req, res) => {
  const connector = await connectorService.createConnectorRecord({
    tenantId: getTenantId(req),
    actorId: actorOf(req),
    type: req.body.type,
    name: req.body.name,
    config: req.body.config,
    fieldMapping: req.body.fieldMapping,
  });
  return ApiResponse.created(res, connector, 'Connector created');
});

/** PATCH /api/v1/connectors/:connectorId - update (type immutable). */
export const update = asyncHandler(async (req, res) => {
  const connector = await connectorService.updateConnectorRecord({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    actorId: actorOf(req),
    patch: req.body,
  });
  return ApiResponse.ok(res, connector, 'Connector updated');
});

/** DELETE /api/v1/connectors/:connectorId - soft delete. */
export const remove = asyncHandler(async (req, res) => {
  await connectorService.deleteConnectorRecord({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    actorId: actorOf(req),
  });
  return ApiResponse.noContent(res);
});

/** POST /api/v1/connectors/:connectorId/validate - config check. */
export const validate = asyncHandler(async (req, res) => {
  const outcome = await connectorService.validateConnectorRecord({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
  });
  const status = outcome.valid ? 200 : 422;
  return ApiResponse.send(
    res,
    status,
    {
      valid: outcome.valid,
      errors: outcome.errors,
      connector: outcome.connector,
    },
    'Connector validation',
  );
});

/** GET /api/v1/connectors/:connectorId/rows - ingested rows (paged). */
export const listRows = asyncHandler(async (req, res) => {
  const result = await connectorService.listConnectorRows({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    page: Number(req.query.page) || 1,
    limit: Math.min(Number(req.query.limit) || 50, 200),
  });
  return ApiResponse.ok(res, result.docs, 'Connector rows', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /api/v1/connectors/:connectorId/sync-runs - sync history (paged). */
export const listSyncRuns = asyncHandler(async (req, res) => {
  const result = await connectorService.listSyncRuns({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    status: typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined,
    page: Math.max(1, Math.floor(Number(req.query.page)) || 1),
    limit: Math.min(Math.max(1, Math.floor(Number(req.query.limit)) || 20), 100),
  });
  return ApiResponse.ok(res, result.docs, 'Connector sync runs', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /api/v1/connectors/:connectorId/preview - CSV header/sample preview. */
export const previewCsv = asyncHandler(async (req, res) => {
  const result = await connectorService.previewCsvUpload({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    buffer: req.file?.buffer,
    detectedType: req.file?.detectedType,
    limit: Number(req.body?.limit) || 10,
  });
  return ApiResponse.ok(res, result, 'CSV preview');
});

/** POST /api/v1/connectors/:connectorId/sync - enqueue a CSV stream-parse sync. */
export const syncCsv = asyncHandler(async (req, res) => {
  const result = await connectorService.syncCsvUpload({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    actorId: actorOf(req),
    buffer: req.file?.buffer,
    filename: req.file?.originalname ?? null,
    detectedType: req.file?.detectedType,
  });
  return ApiResponse.accepted(res, result, 'CSV sync enqueued');
});

export default {
  listTypes,
  list,
  getById,
  create,
  update,
  remove,
  validate,
  listRows,
  listSyncRuns,
  getSchema,
  refreshSchema,
  discover,
  previewCsv,
  syncCsv,
  previewFile,
  previewNewFile,
  importFile,
  syncFile,
  syncMongoDB,
};
