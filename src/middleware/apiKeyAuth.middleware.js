/**
 * API Key Authentication Middleware (Sprint 9 - implemented).
 *
 * WHY IT EXISTS
 *   The external API surface uses `X-Api-Key` header (format `prefix.secret`).
 *   This middleware validates the key via `apiKey.service.authenticateApiKey`,
 *   attaches `req.apiKey = { keyId, tenantId, scopes }` and
 *   `req.tenant = tenantId` for downstream handlers.
 *
 * POSITION
 *   Mounted BEFORE any route that needs external auth. Runs independently
 *   of JWT auth (different audience). Does NOT set `req.user` or `req.admin`.
 *
 * ERROR HANDLING
 *   - Missing header → 401 { code: 'UNAUTHENTICATED', message: 'API key required' }
 *   - Invalid/expired/revoked key → 401 { code: 'INVALID_API_KEY', ... }
 *   - All errors are opaque (same message) to prevent key enumeration.
 */

import apiKeyService from '../services/apiKey.service.js';
import ApiError from '../utils/ApiError.js';

/** Middleware factory - optionally requires a specific scope. */
export function authenticateApiKey(requiredScope = null) {
  return async (req, res, next) => {
    try {
      const header = req.headers['x-api-key'] ?? req.headers['X-Api-Key'];
      const result = await apiKeyService.authenticateApiKey(header);
      req.apiKey = result;
      req.tenant = result.tenantId;

      if (requiredScope && !apiKeyService.hasScope(result, requiredScope)) {
        throw new Error(`Scope "${requiredScope}" is required`);
      }
      next();
    } catch (err) {
      // Normalize all auth failures to 401 with opaque message.
      const message = err?.message?.includes('Scope') ? err.message : 'Invalid or expired API key';
      const code = err?.message?.includes('Scope') ? 'INSUFFICIENT_SCOPE' : 'INVALID_API_KEY';
      return next(ApiError.unauthorized(message, code));
    }
  };
}

/** Convenience: require a specific scope. */
export function requireScope(scope) {
  return authenticateApiKey(scope);
}

export default { authenticateApiKey, requireScope };