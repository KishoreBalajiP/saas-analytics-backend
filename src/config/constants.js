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
