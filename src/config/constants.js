/**
 * Static application constants.
 *
 * WHY IT EXISTS
 *   Keeps magic values (HTTP codes, event names, limits, defaults) in one
 *   documented place so behaviour is consistent across the codebase and
 *   easy to change without hunting through files.
 *
 * RESPONSIBILITY
 *   Export frozen, environment-independent constants used by the framework.
 *   Values that can vary per environment belong in `config/env.js` instead.
 *
 * HOW TO EXTEND
 *   Add a new constant group (e.g. `export const TENANT = {...}`) when a new
 *   concern appears. Never import these for per-deployment values.
 */

/** HTTP status codes - use these instead of raw numbers. */
export const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  SERVICE_UNAVAILABLE: 503,
});

/** Machine-readable error codes returned inside ApiError payloads. */
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  GONE: 'GONE',
  LOCKED: 'LOCKED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Auth-specific codes the frontend branches on for precise UX. The HTTP
  // status alone cannot distinguish "wrong password" from "email not
  // verified" from "workspace URL taken".
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
  MFA_REQUIRED: 'MFA_REQUIRED',
  // Session and request-replay codes (auth hardening).
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  SESSION_COOKIE_MISSING: 'SESSION_COOKIE_MISSING',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
  WORKSPACE_SLUG_TAKEN: 'WORKSPACE_SLUG_TAKEN',
  // Plan limits (roadmap 1.3): one typed code for every hard-limit refusal,
  // and a distinct code when the subscription state blocks writes.
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SUBSCRIPTION_WRITE_BLOCKED: 'SUBSCRIPTION_WRITE_BLOCKED',
  // members: workspace membership guards (roadmap 2.10). STEP_UP_FAILED is
  // shared with adminauth and declared there.
  LAST_OWNER: 'LAST_OWNER',
  ROLE_CEILING: 'ROLE_CEILING',
  MEMBERSHIP_BUSY: 'MEMBERSHIP_BUSY',
  DELETION_PENDING: 'DELETION_PENDING',
  // roles: platform role model (roadmap 2.1): a tenant-scoped admin reached
  // outside its tenant, a role above the admin's type, the last-super guard.
  ADMIN_SCOPE_DENIED: 'ADMIN_SCOPE_DENIED',
  ROLE_ABOVE_ADMIN_TYPE: 'ROLE_ABOVE_ADMIN_TYPE',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  // retention: an export / report artefact whose download window has passed
  // (410). The client should request a new export instead of retrying.
  EXPORT_EXPIRED: 'EXPORT_EXPIRED',
  // adminauth: MFA enrolment policy and step-up re-authentication.
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  STEP_UP_FAILED: 'STEP_UP_FAILED',
  // billing: the tenant's plan does not include a feature (requireFeature).
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  // mfa-tenant: an Owner must use MFA before requiring it for the workspace.
  MFA_NOT_ENABLED: 'MFA_NOT_ENABLED',
});

/** Pagination defaults for future list endpoints. */
export const PAGINATION = Object.freeze({
  defaultPage: 1,
  defaultLimit: 20,
  maxLimit: 100,
});

/** Placeholder role names for the future RBAC system. */
export const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  ANALYST: 'analyst',
  MEMBER: 'member',
});

/**
 * Future tenant-scoped collections are prefixed so one physical MongoDB can
 * safely host multiple tenants (e.g. `t_62abc..._sessions`).
 */
export const COLLECTION = Object.freeze({
  TENANT_PREFIX: 't_',
  SEPARATOR: '_',
});

/** Reserved Socket.IO event names and room conventions. */
export const SOCKET = Object.freeze({
  EVENTS: Object.freeze({
    CONNECTED: 'app:connected',
    PING: 'app:ping',
    ERROR: 'app:error',
    DASHBOARD_UPDATED: 'dashboard:updated',
    EMBED_UPDATED: 'embed:updated',
    NOTIFICATION: 'notification:created',
  }),
  ROOMS: Object.freeze({
    ALL: 'app:all',
    TENANT_PREFIX: 'tenant:',
    DASHBOARD_PREFIX: 'dashboard:',
  }),
  STATUS: Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
  }),
});

/** Default cron expressions for the background jobs (overridable via env). */
export const JOB = Object.freeze({
  NAMES: Object.freeze({
    SHEET_SYNC: 'sheet-sync',
    EMAIL: 'email-queue',
    CLEANUP: 'cleanup',
    ANOMALY: 'anomaly-detection',
  }),
  CRON: Object.freeze({
    SHEET_SYNC: '0 */6 * * *',
    EMAIL: '*/5 * * * *',
    CLEANUP: '0 3 * * *',
    ANOMALY: '0 * * * *',
  }),
  TIMEZONE: 'UTC',
});

/** Date handling defaults used by `utils/date.js`. */
export const DATE = Object.freeze({
  ISO_FORMAT: "yyyy-MM-dd'T'HH:mm:ss.SSSxxx",
  DEFAULT_TIMEZONE: 'UTC',
});

/** Future upload constraints (not enforced yet). */
export const UPLOAD = Object.freeze({
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_EXTENSIONS: ['.csv', '.xlsx', '.json'],
});
