/**
 * API Key Controller (Sprint 9 - implemented).
 */

import apiKeyService from '../services/apiKey.service.js';
import { validateCreateApiKey, validateUpdateApiKey, validateRevokeApiKey } from '../validators/apiKey.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';

export async function createApiKey(req, res, next) {
  try {
    const { valid, errors } = validateCreateApiKey(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { key, secret } = await apiKeyService.createApiKey({
      tenantId: req.tenant,
      name: req.body.name,
      scopes: req.body.scopes,
      expiresAt: req.body.expiresAt,
      actorId: req.user?._id,
    });
    // Return the full secret ONCE in the response.
    return ApiResponse.created(res, { key, secret }, 'API key created. Store the secret securely — it will not be shown again.');
  } catch (err) {
    next(err);
  }
}

export async function listApiKeys(req, res, next) {
  try {
    const result = await apiKeyService.listApiKeys({
      tenantId: req.tenant,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      status: req.query.status,
    });
    return ApiResponse.ok(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getApiKey(req, res, next) {
  try {
    const key = await apiKeyService.getApiKey({ tenantId: req.tenant, keyId: req.params.id });
    if (!key) return next(ApiError.notFound('API key not found'));
    return ApiResponse.ok(res, key);
  } catch (err) {
    next(err);
  }
}

export async function updateApiKey(req, res, next) {
  try {
    const { valid, errors } = validateUpdateApiKey(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const updated = await apiKeyService.updateApiKey({
      tenantId: req.tenant,
      keyId: req.params.id,
      actorId: req.user?._id,
      patch: req.body,
    });
    if (!updated) return next(ApiError.notFound('API key not found or no changes'));
    return ApiResponse.ok(res, updated, 'API key updated');
  } catch (err) {
    next(err);
  }
}

export async function revokeApiKey(req, res, next) {
  try {
    const { valid, errors } = validateRevokeApiKey(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const result = await apiKeyService.revokeApiKey({
      tenantId: req.tenant,
      keyId: req.params.id,
      actorId: req.user?._id,
      reason: req.body.reason,
    });
    if (!result) return next(ApiError.notFound('API key not found or already revoked'));
    return ApiResponse.ok(res, result, 'API key revoked');
  } catch (err) {
    next(err);
  }
}

export default { createApiKey, listApiKeys, getApiKey, updateApiKey, revokeApiKey };