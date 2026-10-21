/**
 * Embed Token Validators (roadmap 3.2). Deep checks (origins, locked
 * filters, params) live in embed.service.js; these catch shape errors.
 */

import env from '../config/env.js';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateCreateEmbedToken(body) {
  const errors = [];
  if (!isObj(body)) return { valid: false, errors: [{ field: 'body', message: 'must be an object' }] };
  if (!body.dashboardId || typeof body.dashboardId !== 'string') {
    errors.push({ field: 'dashboardId', message: 'dashboardId is required' });
  }
  if (body.widgetId !== undefined && body.widgetId !== null && typeof body.widgetId !== 'string') {
    errors.push({ field: 'widgetId', message: 'widgetId must be a string' });
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    errors.push({ field: 'name', message: 'name must be a string' });
  }
  if (body.ttlSec !== undefined && body.ttlSec !== null) {
    const n = Number(body.ttlSec);
    if (!Number.isFinite(n) || n < 60 || n > env.security.embed.maxTtlSec) {
      errors.push({ field: 'ttlSec', message: `ttlSec must be between 60 and ${env.security.embed.maxTtlSec}` });
    }
  }
  if (body.allowedOrigins !== undefined && !Array.isArray(body.allowedOrigins)) {
    errors.push({ field: 'allowedOrigins', message: 'must be an array of origins' });
  }
  if (body.lockedFilters !== undefined && body.lockedFilters !== null && !isObj(body.lockedFilters)) {
    errors.push({ field: 'lockedFilters', message: 'must be a filter envelope object' });
  }
  if (body.params !== undefined && body.params !== null && !isObj(body.params)) {
    errors.push({ field: 'params', message: 'must be an object' });
  }
  return { valid: errors.length === 0, errors };
}

export function validateCreateShareLink(body) {
  const errors = [];
  if (!isObj(body)) return { valid: false, errors: [{ field: 'body', message: 'must be an object' }] };
  if (!body.dashboardId || typeof body.dashboardId !== 'string') errors.push({ field: 'dashboardId', message: 'dashboardId is required' });
  if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'name must be a string' });
  if (body.ttlSec !== undefined && body.ttlSec !== null) {
    const n = Number(body.ttlSec);
    if (!Number.isFinite(n) || n < 60 || n > env.security.embed.shareMaxTtlSec) {
      errors.push({ field: 'ttlSec', message: `ttlSec must be between 60 and ${env.security.embed.shareMaxTtlSec}` });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRevokeEmbedToken(body) {
  const errors = [];
  if (body?.reason !== undefined && typeof body.reason !== 'string') {
    errors.push({ field: 'reason', message: 'reason must be a string' });
  }
  return { valid: errors.length === 0, errors };
}

export default { validateCreateEmbedToken, validateCreateShareLink, validateRevokeEmbedToken };
