/**
 * Embed Token Validators (Sprint 9 - implemented).
 */

import env from '../config/env.js';

export function validateCreateEmbedToken(body) {
  const errors = [];
  if (!body?.dashboardId) {
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
  return { valid: errors.length === 0, errors };
}

export function validateRevokeEmbedToken(body) {
  const errors = [];
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    errors.push({ field: 'reason', message: 'reason must be a string' });
  }
  return { valid: errors.length === 0, errors };
}

export default { validateCreateEmbedToken, validateRevokeEmbedToken };