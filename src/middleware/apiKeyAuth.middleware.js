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
 *   - A presented-but-refused key (invalid, expired, revoked, tenant not
 *     active, missing scope) is recorded as a rate-limited `request.denied`
 *     security event. A request without the header is not.
 *
 * METERING
 *   Every authenticated call counts toward the tenant's `apiCallsPerDay`
 *   quota for the current UTC day (`usageService.meterApiCall`). Over a hard
 *   limit the call is refused with 429 `QUOTA_EXCEEDED` and `Retry-After`
 *   set to the reset. `X-Quota-Limit`, `X-Quota-Remaining` and
 *   `X-Quota-Reset` report the daily budget on every metered response.
 */

import apiKeyService from '../services/apiKey.service.js';
import usageService from '../services/usage.service.js';
import ApiError from '../utils/ApiError.js';
import { auditDenied } from './audit.middleware.js';
// devapi: per-key limiter and usage metering.
import env from '../config/env.js';
import { createRateLimiter } from './rateLimiter.middleware.js';
import apiKeyUsageService from '../services/apiKeyUsage.service.js';

/** Count the request per key, endpoint pattern and final status. */
function trackUsage(req, res) {
  res.on('finish', () => {
    const route = req.route?.path ? `${req.method} ${req.route.path}` : `${req.method} (unmatched)`;
    void apiKeyUsageService.record({ tenantId: req.apiKey?.tenantId, keyId: req.apiKey?.keyId, endpoint: route, status: res.statusCode });
  });
}

/**
 * devapi: per-key rate limit, mounted AFTER authenticateApiKey so the
 * bucket is the key, not the client IP (Redis store when REDIS_URL is set).
 */
export const apiKeyRateLimit = createRateLimiter({
  name: 'api-key',
  windowMs: env.security.apiKeys.rateLimitWindowMs,
  limit: env.security.apiKeys.rateLimitMax,
  keyGenerator: (req) => `key:${req.apiKey?.keyId ?? 'anonymous'}`,
});

/** Expose the daily API-call budget to the caller. */
function setQuotaHeaders(res, { limit, remaining, resetsAt }) {
  if (limit !== null && limit !== undefined) {
    res.setHeader('X-Quota-Limit', String(limit));
    res.setHeader('X-Quota-Remaining', String(Math.max(0, remaining ?? 0)));
  }
  if (resetsAt) res.setHeader('X-Quota-Reset', String(Math.ceil(new Date(resetsAt).getTime() / 1000)));
}

/** Count the call; refuse it when the tenant's daily budget is spent. */
async function meter(req, res, next) {
  try {
    const usage = await usageService.meterApiCall({ tenantId: req.apiKey.tenantId });
    setQuotaHeaders(res, usage);
    return next();
  } catch (err) {
    if (err?.code === 'QUOTA_EXCEEDED' && err.details) {
      setQuotaHeaders(res, { limit: err.details.limit, remaining: 0, resetsAt: err.details.resetsAt });
      const wait = Math.ceil((new Date(err.details.resetsAt).getTime() - Date.now()) / 1000);
      if (Number.isFinite(wait) && wait > 0) res.setHeader('Retry-After', String(wait));
    }
    return next(err);
  }
}

/** Middleware factory - optionally requires a specific scope. */
export function authenticateApiKey(requiredScope = null) {
  return async (req, res, next) => {
    try {
      const header = req.headers['x-api-key'] ?? req.headers['X-Api-Key'];
      const result = await apiKeyService.authenticateApiKey(header, { ip: req.ip });
      req.apiKey = result;
      req.tenant = result.tenantId;

      if (requiredScope && !apiKeyService.hasScope(result, requiredScope)) {
        throw new Error(`Scope "${requiredScope}" is required`);
      }
    } catch (err) {
      // Normalize all auth failures to 401 with opaque message.
      const scopeFailure = Boolean(err?.message?.includes('Scope'));
      const message = scopeFailure ? err.message : 'Invalid or expired API key';
      const code = scopeFailure ? 'INSUFFICIENT_SCOPE' : 'INVALID_API_KEY';
      // devapi: typed refusals (401 INVALID_API_KEY, 403 INSUFFICIENT_SCOPE).
      const refusal = new ApiError(scopeFailure ? 403 : 401, message, { code });
      const header = req.headers['x-api-key'] ?? req.headers['X-Api-Key'];
      if (header) {
        auditDenied(req, refusal, scopeFailure ? 'api_key_scope' : 'api_key_invalid', scopeFailure ? { scope: requiredScope } : {});
      }
      return next(refusal);
    }
    trackUsage(req, res);
    return meter(req, res, next);
  };
}

/** Convenience: require a specific scope. */
export function requireScope(scope) {
  return authenticateApiKey(scope);
}

export default { authenticateApiKey, requireScope, apiKeyRateLimit };