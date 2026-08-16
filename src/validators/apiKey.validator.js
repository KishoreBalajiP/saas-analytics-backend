/**
 * API Key Validators (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Validation rules for the API key management surface. Reused by
 *   controllers and (if needed) the external API surface.
 */

import { API_KEY_SCOPES } from '../models/ApiKey.js';

export function validateCreateApiKey(body) {
  const errors = [];
  if (!body?.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'name is required' });
  } else if (body.name.length > 120) {
    errors.push({ field: 'name', message: 'name must be at most 120 characters' });
  }
  if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
    errors.push({ field: 'scopes', message: 'scopes must be a non-empty array' });
  } else {
    for (const scope of body.scopes) {
      if (!API_KEY_SCOPES.includes(scope)) {
        errors.push({ field: 'scopes', message: `invalid scope "${scope}"` });
      }
    }
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const d = new Date(body.expiresAt);
    if (isNaN(d.getTime())) {
      errors.push({ field: 'expiresAt', message: 'expiresAt must be a valid ISO-8601 date' });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateUpdateApiKey(body) {
  const errors = [];
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      errors.push({ field: 'name', message: 'name cannot be empty' });
    } else if (body.name.length > 120) {
      errors.push({ field: 'name', message: 'name must be at most 120 characters' });
    }
  }
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      errors.push({ field: 'scopes', message: 'scopes must be a non-empty array' });
    } else {
      for (const scope of body.scopes) {
        if (!API_KEY_SCOPES.includes(scope)) {
          errors.push({ field: 'scopes', message: `invalid scope "${scope}"` });
        }
      }
    }
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const d = new Date(body.expiresAt);
    if (isNaN(d.getTime())) {
      errors.push({ field: 'expiresAt', message: 'expiresAt must be a valid ISO-8601 date' });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRevokeApiKey(body) {
  const errors = [];
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    errors.push({ field: 'reason', message: 'reason must be a string' });
  }
  return { valid: errors.length === 0, errors };
}

export default { validateCreateApiKey, validateUpdateApiKey, validateRevokeApiKey };