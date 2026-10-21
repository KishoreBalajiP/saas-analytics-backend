/**
 * Support access constants (roadmap 2.3).
 *
 * WHY A CONSTANTS FILE
 *   The support access model (tenant consent, break-glass, read-only
 *   impersonation) has a small vocabulary that the services, the auth
 *   middleware, the validators and the tests all share. Keeping it here
 *   avoids string drift and keeps the shared `config/constants.js` free of
 *   package-specific codes.
 *
 * ERROR CODES
 *   Machine codes the frontend branches on (`ApiError.code`):
 *   - IMPERSONATION_READ_ONLY        403  write attempted with a support session
 *   - IMPERSONATION_SESSION_REQUIRED 403  endpoint only for support sessions
 *   - SUPPORT_CONSENT_REQUIRED       403  no active consent / approved break-glass
 *   - SUPPORT_TARGET_PROTECTED       403  target belongs to platform staff
 *   - SUPPORT_IMPERSONATION_CAP_EXCEEDED 429 per-admin daily cap reached
 *   - BREAK_GLASS_APPROVAL_DENIED    403  approver is not an eligible super admin
 *   - SUPPORT_GRANT_NOT_ACTIVE       409  grant cannot change state any more
 */

export const SUPPORT_ERROR_CODES = Object.freeze({
  IMPERSONATION_READ_ONLY: 'IMPERSONATION_READ_ONLY',
  IMPERSONATION_SESSION_REQUIRED: 'IMPERSONATION_SESSION_REQUIRED',
  SUPPORT_CONSENT_REQUIRED: 'SUPPORT_CONSENT_REQUIRED',
  SUPPORT_TARGET_PROTECTED: 'SUPPORT_TARGET_PROTECTED',
  SUPPORT_IMPERSONATION_CAP_EXCEEDED: 'SUPPORT_IMPERSONATION_CAP_EXCEEDED',
  BREAK_GLASS_APPROVAL_DENIED: 'BREAK_GLASS_APPROVAL_DENIED',
  SUPPORT_GRANT_NOT_ACTIVE: 'SUPPORT_GRANT_NOT_ACTIVE',
});

/** Kinds of support access grant. */
export const SUPPORT_GRANT_KINDS = Object.freeze(['consent', 'break_glass']);

/**
 * Grant lifecycle:
 *   consent:     active -> revoked | expired (computed from expiresAt)
 *   break_glass: pending -> active | denied ; active -> revoked | expired
 */
export const SUPPORT_GRANT_STATUSES = Object.freeze(['pending', 'active', 'denied', 'revoked']);

/** Lifecycle of a recorded impersonation session. */
export const SUPPORT_IMPERSONATION_STATUSES = Object.freeze(['active', 'ended']);

/** HTTP methods a support (impersonation) session may use. */
export const IMPERSONATION_SAFE_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/** Tenant-chosen consent windows are bounded (hours). */
export const CONSENT_MIN_HOURS = 1;

/** Hard ceiling on one impersonation token / session, whatever the env says. */
export const IMPERSONATION_MAX_TTL_SECONDS = 60 * 60;

/** Audit modules used for the tenant-visible support trail. */
export const SUPPORT_AUDIT_MODULES = Object.freeze({
  ACCESS: 'support.access',
  IMPERSONATION: 'support.impersonation',
  DIAGNOSTICS: 'support.diagnostics',
});

export default {
  SUPPORT_ERROR_CODES,
  SUPPORT_GRANT_KINDS,
  SUPPORT_GRANT_STATUSES,
  SUPPORT_IMPERSONATION_STATUSES,
  IMPERSONATION_SAFE_METHODS,
  CONSENT_MIN_HOURS,
  IMPERSONATION_MAX_TTL_SECONDS,
  SUPPORT_AUDIT_MODULES,
};
