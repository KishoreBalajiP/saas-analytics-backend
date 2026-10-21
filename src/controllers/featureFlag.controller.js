/**
 * Feature Flag Controller (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/feature-flags`:
 *   - platform admins manage the flag catalogue (CRUD, history, rollback,
 *     per-tenant preview);
 *   - tenant users read which flags are on for THEIR workspace
 *     (`GET /evaluate`), which the frontend feature-flag hook consumes.
 *
 * CODING GUIDELINES
 *   - The actor comes from the token, never from the body.
 *   - Flag fields are taken from the raw body (only the known keys): the
 *     generic validator drops empty strings, and clearing a description is
 *     legitimate. The service validates every field.
 *   - `/evaluate` uses the tenant resolved from the session; a tenant user
 *     can never evaluate flags for another tenant.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import featureFlagService from '../services/featureFlag.service.js';

// `type` is passed through so a non-boolean flag is refused, not silently ignored.
const FLAG_FIELDS = ['name', 'description', 'enabled', 'rollout', 'type'];

function actorOf(req) {
  return { type: 'admin', id: req.admin?.id ?? null, email: req.admin?.email ?? null };
}

function pick(body, keys) {
  const out = {};
  for (const key of keys) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

function pageMeta(result) {
  return { page: result.page, limit: result.limit, total: result.total, pages: result.pages };
}

/** GET /feature-flags - paginated catalogue. */
export const listFlags = asyncHandler(async (req, res) => {
  const { search, enabled, page = 1, limit = 20 } = req.validated?.query ?? {};
  const result = await featureFlagService.listFlags({ search, enabled, page, limit });
  return ApiResponse.ok(res, result.docs, 'Feature flags fetched', pageMeta(result));
});

/** GET /feature-flags/:key */
export const getFlag = asyncHandler(async (req, res) => {
  const flag = await featureFlagService.getFlag(req.validated.params.key);
  return ApiResponse.ok(res, flag, 'Feature flag fetched');
});

/** POST /feature-flags */
export const createFlag = asyncHandler(async (req, res) => {
  const flag = await featureFlagService.createFlag({
    data: { key: req.body?.key, ...pick(req.body, FLAG_FIELDS) },
    actor: actorOf(req),
    reason: req.validated?.body?.reason ?? null,
  });
  return ApiResponse.created(res, flag, 'Feature flag created');
});

/** PATCH /feature-flags/:key */
export const updateFlag = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const flag = await featureFlagService.updateFlag({
    key: req.validated.params.key,
    patch: pick(req.body, FLAG_FIELDS),
    version: body.version,
    actor: actorOf(req),
    reason: body.reason ?? null,
  });
  return ApiResponse.ok(res, flag, 'Feature flag updated');
});

/** DELETE /feature-flags/:key?version= */
export const deleteFlag = asyncHandler(async (req, res) => {
  const query = req.validated?.query ?? {};
  const result = await featureFlagService.deleteFlag({
    key: req.validated.params.key,
    version: query.version,
    actor: actorOf(req),
    reason: query.reason ?? null,
  });
  return ApiResponse.ok(res, result, 'Feature flag deleted');
});

/** GET /feature-flags/:key/history */
export const flagHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.validated?.query ?? {};
  const result = await featureFlagService.flagHistory({ key: req.validated.params.key, page, limit });
  return ApiResponse.ok(res, result.docs, 'Feature flag history fetched', pageMeta(result));
});

/** POST /feature-flags/:key/rollback */
export const rollbackFlag = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const flag = await featureFlagService.rollbackFlag({
    key: req.validated.params.key,
    toVersion: body.toVersion,
    version: body.version,
    actor: actorOf(req),
    reason: body.reason ?? null,
  });
  return ApiResponse.ok(res, flag, `Feature flag rolled back to version ${body.toVersion}`);
});

/** GET /feature-flags/preview?tenantId= - every flag's outcome for one tenant. */
export const previewFlags = asyncHandler(async (req, res) => {
  const { tenantId } = req.validated.query;
  const outcomes = await featureFlagService.previewForTenant(tenantId);
  return ApiResponse.ok(res, outcomes, 'Feature flag preview', { tenantId, total: outcomes.length });
});

/** GET /feature-flags/evaluate - the caller's workspace flags (tenant users). */
export const evaluateFlags = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const flags = await featureFlagService.resolveForTenant(tenantId);
  res.set('Cache-Control', 'private, no-cache');
  return ApiResponse.ok(res, { flags }, 'Feature flags evaluated');
});

export default {
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  deleteFlag,
  flagHistory,
  rollbackFlag,
  previewFlags,
  evaluateFlags,
};
