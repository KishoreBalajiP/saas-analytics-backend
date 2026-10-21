/**
 * Embed Controller (roadmap 3.2 - signed, origin-bound embed sessions).
 */

import embedService from '../services/embed.service.js';
import { validateCreateEmbedToken, validateRevokeEmbedToken, validateCreateShareLink } from '../validators/embed.validator.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';

function mintArgs(body) {
  return {
    dashboardId: body.dashboardId,
    widgetId: body.widgetId,
    name: body.name,
    ttlSec: body.ttlSec,
    allowedOrigins: body.allowedOrigins,
    lockedFilters: body.lockedFilters,
    params: body.params,
    theme: body.theme,
  };
}

const MINTED = 'Embed token created. Pass it to the embed SDK from your page; it will not be shown again.';

export async function createEmbedToken(req, res, next) {
  try {
    const { valid, errors } = validateCreateEmbedToken(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { token, secret } = await embedService.createEmbedToken({
      tenantId: getTenantId(req), ...mintArgs(req.body), actorId: req.user?.id ?? null, via: 'user',
    });
    return ApiResponse.created(res, { token, secret }, MINTED);
  } catch (err) {
    next(err);
  }
}

/** Mint through an API key carrying the `embed:create` scope. */
export async function createEmbedTokenWithApiKey(req, res, next) {
  try {
    const { valid, errors } = validateCreateEmbedToken(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { token, secret } = await embedService.createEmbedToken({
      tenantId: String(req.apiKey.tenantId), ...mintArgs(req.body), actorId: `api_key:${req.apiKey.keyId}`, via: 'api_key',
    });
    return ApiResponse.created(res, { token, secret }, MINTED);
  } catch (err) {
    next(err);
  }
}

export async function listEmbedTokens(req, res, next) {
  try {
    const result = await embedService.listEmbedTokens({
      tenantId: getTenantId(req),
      dashboardId: req.query.dashboardId,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    return ApiResponse.ok(res, result.docs, 'Listed', {
      page: result.page, limit: result.limit, total: result.total, pages: result.pages,
    });
  } catch (err) {
    next(err);
  }
}

export async function getEmbedToken(req, res, next) {
  try {
    const token = await embedService.getEmbedToken({ tenantId: getTenantId(req), tokenId: req.params.id });
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
      tenantId: getTenantId(req), tokenId: req.params.id, actorId: req.user?.id ?? null, reason: req.body?.reason,
    });
    if (!result) return next(ApiError.notFound('Embed token not found or already revoked'));
    return ApiResponse.ok(res, result, 'Embed token revoked');
  } catch (err) {
    next(err);
  }
}

export async function createShareLink(req, res, next) {
  try {
    const { valid, errors } = validateCreateShareLink(req.body);
    if (!valid) return next(ApiError.badRequest('Validation failed', errors));
    const { token, secret } = await embedService.createShareLink({
      tenantId: getTenantId(req), dashboardId: req.body.dashboardId, name: req.body.name, ttlSec: req.body.ttlSec, actorId: req.user?.id ?? null,
    });
    return ApiResponse.created(res, { token, secret }, 'Share link created. It will not be shown again.');
  } catch (err) {
    next(err);
  }
}

export async function getConfig(req, res, next) {
  try {
    return ApiResponse.ok(res, await embedService.getConfig({ tenantId: getTenantId(req) }));
  } catch (err) {
    next(err);
  }
}

export async function updateConfig(req, res, next) {
  try {
    return ApiResponse.ok(res, await embedService.updateConfig({ tenantId: getTenantId(req), actorId: req.user?.id ?? null, patch: req.body }), 'Embed settings updated');
  } catch (err) {
    next(err);
  }
}

/* ------------------------------ public surface ---------------------------- */

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function exchangeSession(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = await embedService.exchangeSession({
      token: typeof body.token === 'string' ? body.token : null,
      origin: req.headers.origin,
      parentOrigin: typeof body.parentOrigin === 'string' ? body.parentOrigin : null,
    });
    res.setHeader('Cache-Control', 'no-store');
    return ApiResponse.ok(res, session, 'Embed session started');
  } catch (err) {
    next(err);
  }
}

export async function viewEmbed(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const view = await embedService.viewEmbed({
      sessionToken: bearer(req),
      origin: req.headers.origin,
      parentOrigin: typeof body.parentOrigin === 'string' ? body.parentOrigin : null,
      filters: body.filters,
    });
    res.setHeader('Cache-Control', 'no-store');
    return ApiResponse.ok(res, view);
  } catch (err) {
    next(err);
  }
}

export async function viewShare(req, res, next) {
  try {
    const secret = typeof req.body?.secret === 'string' ? req.body.secret : null;
    res.setHeader('Cache-Control', 'no-store');
    return ApiResponse.ok(res, await embedService.viewShare({ secret }));
  } catch (err) {
    next(err);
  }
}

export default {
  createEmbedToken, createEmbedTokenWithApiKey, listEmbedTokens, getEmbedToken, revokeEmbedToken,
  createShareLink, getConfig, updateConfig, exchangeSession, viewEmbed, viewShare,
};
