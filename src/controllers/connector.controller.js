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

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import connectorService from '../services/connector.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** GET /api/v1/connectors/types - registered connector catalogue. */
export const listTypes = asyncHandler(async (_req, res) => {
  return ApiResponse.ok(res, connectorService.listConnectorTypes(), 'Connector types');
});

/** GET /api/v1/connectors - paginated, tenant-scoped list. */
export const list = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const result = await connectorService.listConnectorRecords({
    tenantId,
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
  return ApiResponse.send(res, status, { valid: outcome.valid, errors: outcome.errors, connector: outcome.connector }, 'Connector validation');
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

/** POST /api/v1/connectors/:connectorId/preview - CSV header/sample preview. */
export const previewCsv = asyncHandler(async (req, res) => {
  const result = await connectorService.previewCsvUpload({
    tenantId: getTenantId(req),
    connectorId: req.params.connectorId,
    buffer: req.file?.buffer,
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
  previewCsv,
  syncCsv,
};
