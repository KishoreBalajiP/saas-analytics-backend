/**
 * requireFeature middleware (billing, roadmap 3.1 - feature entitlements).
 *
 * PURPOSE
 *   Server-side enforcement of plan features (finding bil.06). Answers 403
 *   `FEATURE_NOT_AVAILABLE` when the tenant's plan - computed from the
 *   subscription state and period on every check, plus active entitlement
 *   overrides - does not include the feature. The UI may hide gated
 *   features, but this gate is the authority.
 *
 * CONTRACT (contracts.md, owner: billing)
 *   - `requireFeature(featureKey, options?)` -> Express middleware
 *   - `entitlementService.hasFeature({ tenantId, feature })`
 *   - Feature keys (`FEATURE_KEYS`): embedding, api_access,
 *     scheduled_delivery, ai_assistant, sso, audit_streaming,
 *     row_level_security.
 *
 * USAGE
 *   Place it after the authentication / tenant-resolution middleware:
 *     router.post('/tokens', authenticate, resolveTenant,
 *       permission('embed', 'create'), requireFeature('embedding'), handler);
 *   `options.when(req)` makes the gate conditional (e.g. only when a
 *   request enables a schedule); `options.readTenantId(req)` overrides how
 *   the tenant is found.
 *
 * TENANT SOURCE
 *   Only authenticated identity: the API key's tenant, then the JWT tenant
 *   claim, then the tenant resolved by `resolveTenant` (which refuses a
 *   header that disagrees with the claim). Never the body or query.
 *
 * FAILURE MODES
 *   - Unknown feature key at wiring time throws (programming error).
 *   - No tenant on the request -> 403 (deny by default).
 *   - Entitlement lookup failure -> passed to the error handler (5xx);
 *     never treated as "allowed".
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import entitlementService from '../services/entitlement.service.js';
import { FEATURE_KEYS } from '../services/plan.service.js';
import { auditDenied } from './audit.middleware.js';

export { FEATURE_KEYS };

/** Default tenant reader: authenticated identity only. */
export function readFeatureTenantId(req) {
  if (req.apiKey?.tenantId) return String(req.apiKey.tenantId);
  if (req.user?.tenantId && req.user.tenantId !== '*') return String(req.user.tenantId);
  if (typeof req.tenant === 'string' && req.tenant) return req.tenant;
  if (req.tenant?.id) return String(req.tenant.id);
  return null;
}

/** The typed refusal every feature gate answers with. */
export function featureNotAvailableError(feature) {
  const err = new ApiError(403, `Your plan does not include the "${feature}" feature. Upgrade the workspace plan to use it.`, {
    code: ERROR_CODES.FEATURE_NOT_AVAILABLE,
    errors: [{ field: 'feature', message: 'not included in the current plan', feature }],
  });
  err.details = { feature, upgradeHints: ['upgrade_plan', 'contact_admin'] };
  return err;
}

/**
 * @param {string} featureKey - one of `FEATURE_KEYS`.
 * @param {Object} [options]
 * @param {(req) => boolean} [options.when] - gate only when this returns true.
 * @param {(req) => string|null} [options.readTenantId]
 * @returns {import('express').RequestHandler}
 */
export function requireFeature(featureKey, options = {}) {
  if (!FEATURE_KEYS.includes(featureKey)) {
    throw new Error(`requireFeature: unknown feature "${featureKey}"`);
  }
  const readTenantId = options.readTenantId ?? readFeatureTenantId;
  const when = typeof options.when === 'function' ? options.when : null;
  return async function requireFeatureMiddleware(req, _res, next) {
    try {
      if (when && !when(req)) return next();
      const tenantId = readTenantId(req);
      if (tenantId && (await entitlementService.hasFeature({ tenantId, feature: featureKey }))) {
        return next();
      }
      return next(auditDenied(req, featureNotAvailableError(featureKey), 'feature_not_available', { feature: featureKey }));
    } catch (err) {
      return next(err);
    }
  };
}

export default { requireFeature, featureNotAvailableError, readFeatureTenantId, FEATURE_KEYS };
