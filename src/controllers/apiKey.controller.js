/**
 * API Key Controller (Sprint 9 - implemented).
 */

import apiKeyService from '../services/apiKey.service.js';
import { validateCreateApiKey, validateUpdateApiKey, validateRevokeApiKey } from '../validators/apiKey.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
// devapi:
import apiKeyUsageService from '../services/apiKeyUsage.service.js';
import { API_KEY_SCOPE_CATALOGUE } from '../models/ApiKey.js';
import env from '../config/env.js';

export async function createApiKey(req, res, next) {
  try {
    const { valid, errors } = validateCreateApiKey(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { key, secret } = await apiKeyService.createApiKey({
      tenantId: getTenantId(req),
      name: req.body.name,
      scopes: req.body.scopes,
      expiresAt: req.body.expiresAt,
      ipAllowList: req.body.ipAllowList,
      actorId: req.user?.id ?? null,
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
      tenantId: getTenantId(req),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      status: req.query.status,
    });
    // List envelope: data is the array, pagination lives in meta (the
    // shape every other list endpoint and the frontend client use).
    return ApiResponse.ok(res, result.docs, 'Listed', {
      page: result.page,
      limit: result.limit,
      total: result.total,
      pages: result.pages,
    });
  } catch (err) {
    next(err);
  }
}

export async function getApiKey(req, res, next) {
  try {
    const key = await apiKeyService.getApiKey({ tenantId: getTenantId(req), keyId: req.params.id });
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
      tenantId: getTenantId(req),
      keyId: req.params.id,
      actorId: req.user?.id ?? null,
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
      tenantId: getTenantId(req),
      keyId: req.params.id,
      actorId: req.user?.id ?? null,
      reason: req.body.reason,
    });
    if (!result) return next(ApiError.notFound('API key not found or already revoked'));
    return ApiResponse.ok(res, result, 'API key revoked');
  } catch (err) {
    next(err);
  }
}

// devapi: rotation with overlap, per-key usage, scope catalogue.

export async function rotateApiKey(req, res, next) {
  try {
    const { valid, errors } = validateRevokeApiKey(req.body ?? {});
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const result = await apiKeyService.rotateApiKey({
      tenantId: getTenantId(req),
      keyId: req.params.id,
      actorId: req.user?.id ?? null,
      reason: req.body?.reason,
    });
    return ApiResponse.created(res, result, 'API key rotated. Store the new secret securely — it will not be shown again.');
  } catch (err) {
    next(err);
  }
}

export async function getApiKeyUsage(req, res, next) {
  try {
    const tenantId = getTenantId(req);
    const key = await apiKeyService.getApiKey({ tenantId, keyId: req.params.id }).catch(() => null);
    if (!key) return next(ApiError.notFound('API key not found'));
    const usage = await apiKeyUsageService.summary({ tenantId, keyId: req.params.id, days: req.query.days ?? 7 });
    return ApiResponse.ok(res, usage);
  } catch (err) {
    next(err);
  }
}

export async function listScopes(req, res) {
  return ApiResponse.ok(res, Object.entries(API_KEY_SCOPE_CATALOGUE).map(([scope, description]) => ({ scope, description })), 'Listed', {
    maxTtlDays: env.security.apiKeys.maxTtlDays,
    rotationOverlapMinutes: env.security.apiKeys.rotationOverlapMinutes,
  });
}

export default { createApiKey, listApiKeys, getApiKey, updateApiKey, revokeApiKey, rotateApiKey, getApiKeyUsage, listScopes };