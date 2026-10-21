/**
 * Data Access Controller (roadmap 4.E4, rls).
 *
 * HTTP layer for `/api/v1/data-access`. Tenant from the resolved request,
 * actor from the verified token, never from the body.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import dataAccess from '../services/dataAccess.service.js';

function tenantOf(req) {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  return String(tenantId);
}

export const getDataset = asyncHandler(async (req, res) => {
  const result = await dataAccess.getDatasetAccess({ tenantId: tenantOf(req), connectorId: req.params.connectorId });
  return ApiResponse.ok(res, result, 'Dataset access');
});

export const setDataset = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const result = await dataAccess.setDatasetAccess({
    tenantId: tenantOf(req), connectorId: req.params.connectorId, restricted: body.restricted, grants: body.grants ?? [], actorId: req.user.id,
  });
  return ApiResponse.ok(res, result, 'Dataset access updated');
});

export const addPolicy = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const result = await dataAccess.addRowPolicy({
    tenantId: tenantOf(req), connectorId: req.params.connectorId, field: body.field, op: body.op ?? 'eq', attribute: body.attribute, actorId: req.user.id,
  });
  return ApiResponse.created(res, result, 'Row policy created');
});

export const removePolicy = asyncHandler(async (req, res) => {
  const result = await dataAccess.removeRowPolicy({ tenantId: tenantOf(req), policyId: req.params.policyId, actorId: req.user.id });
  return ApiResponse.ok(res, result, 'Row policy deleted');
});

export const getAttributes = asyncHandler(async (req, res) => {
  const result = await dataAccess.getUserAttributes({ tenantId: tenantOf(req), userId: req.params.userId });
  return ApiResponse.ok(res, result, 'User attributes');
});

export const setAttributes = asyncHandler(async (req, res) => {
  const result = await dataAccess.setUserAttributes({
    tenantId: tenantOf(req), userId: req.params.userId, attributes: req.body?.attributes, actorId: req.user.id,
  });
  return ApiResponse.ok(res, result, 'User attributes updated');
});

export const preview = asyncHandler(async (req, res) => {
  const result = await dataAccess.previewAsUser({ tenantId: tenantOf(req), userId: req.body?.userId, query: req.body?.query ?? {} });
  return ApiResponse.ok(res, result, 'Preview');
});

export default { getDataset, setDataset, addPolicy, removePolicy, getAttributes, setAttributes, preview };
