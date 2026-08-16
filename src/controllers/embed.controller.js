/**
 * Embed Controller (Sprint 9 - implemented).
 */

import embedService from '../services/embed.service.js';
import { validateCreateEmbedToken, validateRevokeEmbedToken } from '../validators/embed.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';

export async function createEmbedToken(req, res, next) {
  try {
    const { valid, errors } = validateCreateEmbedToken(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { token, secret } = await embedService.createEmbedToken({
      tenantId: req.tenant,
      dashboardId: req.body.dashboardId,
      widgetId: req.body.widgetId,
      name: req.body.name,
      ttlSec: req.body.ttlSec,
      actorId: req.user?._id,
    });
    return ApiResponse.created(res, { token, secret }, 'Embed token created. Store the token securely — it will not be shown again.');
  } catch (err) {
    next(err);
  }
}

export async function listEmbedTokens(req, res, next) {
  try {
    const result = await embedService.listEmbedTokens({
      tenantId: req.tenant,
      dashboardId: req.query.dashboardId,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    return ApiResponse.ok(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getEmbedToken(req, res, next) {
  try {
    const token = await embedService.getEmbedToken({ tenantId: req.tenant, tokenId: req.params.id });
    if (!token) return next(ApiError.notFound('Embed token not found'));
    return ApiResponse.ok(res, token);
  } catch (err) {
    next(err);
  }
}

export async function revokeEmbedToken(req, res, next) {
  try {
    const { valid, errors } = validateRevokeEmbedToken(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const result = await embedService.revokeEmbedToken({
      tenantId: req.tenant,
      tokenId: req.params.id,
      actorId: req.user?._id,
      reason: req.body.reason,
    });
    if (!result) return next(ApiError.notFound('Embed token not found or already revoked'));
    return ApiResponse.ok(res, result, 'Embed token revoked');
  } catch (err) {
    next(err);
  }
}

export default { createEmbedToken, listEmbedTokens, getEmbedToken, revokeEmbedToken };