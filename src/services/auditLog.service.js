/**
 * Audit Log Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Single write entry point for audit events, plus the read surface for
 *   the `/audit-logs` API. Writes MUST go through `emit` so the event
 *   shape stays consistent and sensitive payloads are always redacted.
 *
 * RESPONSIBILITY
 *   - emit({ actor, action, module, resource, before, after, reason })
 *   - list(filters) / getById / listByModule
 *
 * CODING GUIDELINES
 *   - Sensitive payloads (passwords, tokens, refreshTokenHash, MFA
 *     secrets) are redacted recursively BEFORE persistence - never store
 *     raw secrets in the trail.
 *   - All reads filter by tenant unless the actor is a platform admin
 *     (the controller/middleware layer enforces that; the service accepts
 *     a tenant filter when provided).
 *   - Export requests live in `services/auditExport.service.js`
 *     (`src/queues/` -> `src/storage/`); this module stays read/write for
 *     the trail only.
 */

import ApiError from '../utils/ApiError.js';
import auditLogRepository from '../repositories/auditLog.repository.js';
import { buildAuditFilter } from '../utils/auditFilters.js';

/** Sensitive field names, matched case-insensitively and stripped before persist. */
const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'refreshtoken', 'refreshtokenhash',
  'accesstoken', 'mfasecret', 'mfacode', 'secret', 'authorization',
  'cookie', 'token',
]);

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);
const RESULTS = new Set(['success', 'failure']);

/**
 * Append an audit event to the trail. Validates the shape, redacts any
 * sensitive payload in `before`/`after`, and persists via the repository.
 *
 * @param {Object} opts
 * @param {{ type: 'admin'|'user'|'service'|'system', id: string, display?: string }} opts.actor
 * @param {string} opts.action
 * @param {string} opts.module - e.g. `iam.roles`, `iam.tenants`.
 * @param {{ type?: string, id?: string }} [opts.resource]
 * @param {*} [opts.before]
 * @param {*} [opts.after]
 * @param {string} [opts.reason]
 * @param {string} [opts.tenantId]
 * @param {'success'|'failure'} [opts.result='success']
 * @param {string} [opts.errorCode]
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.requestId]
 * @returns {Promise<Object>} saved event (plain).
 */
export async function emit({
  actor,
  action,
  module,
  resource,
  before,
  after,
  reason,
  tenantId,
  result = 'success',
  errorCode,
  ip,
  userAgent,
  requestId,
} = {}) {
  if (!actor || !ACTOR_TYPES.has(actor.type)) {
    throw ApiError.badRequest('actor.type must be one of admin, user, service, system');
  }
  if (!action || typeof action !== 'string') throw ApiError.badRequest('action is required');
  if (!module || typeof module !== 'string') throw ApiError.badRequest('module is required');
  if (result && !RESULTS.has(result)) {
    throw ApiError.badRequest('result must be "success" or "failure"');
  }

  return auditLogRepository.insert({
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorDisplay: actor.display ?? null,
    tenantId: tenantId ?? null,
    module,
    action,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
    before: redact(before),
    after: redact(after),
    reason: reason ?? null,
    result,
    errorCode: errorCode ?? null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    requestId: requestId ?? null,
  });
}

/**
 * Paginated audit read with optional filters. Applies the tenant filter
 * when provided (platform admins omit it to see everything). Every value
 * is coerced to a safe scalar via `utils/auditFilters.js` - raw input can
 * never become a Mongo operator.
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId]
 * @param {string} [opts.module]
 * @param {string} [opts.action]
 * @param {string} [opts.actorId]
 * @param {string} [opts.actorType]
 * @param {'success'|'failure'} [opts.result]
 * @param {string} [opts.resourceType]
 * @param {string} [opts.resourceId]
 * @param {string} [opts.dateFrom] - ISO date; inclusive start of range.
 * @param {string} [opts.dateTo] - ISO date; inclusive end of range.
 * @param {string} [opts.search] - free-text term (regex-escaped).
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated audit list.
 */
export async function list({
  tenantId,
  module,
  action,
  actorId,
  actorType,
  result,
  resourceType,
  resourceId,
  dateFrom,
  dateTo,
  search,
  page = 1,
  limit = 20,
} = {}) {
  const filter = buildAuditFilter({
    tenantId: tenantId ?? undefined,
    module,
    action,
    actorId,
    actorType,
    result,
    resourceType,
    resourceId,
    dateFrom,
    dateTo,
    search,
  });
  return auditLogRepository.list({ filter, page, limit });
}

/**
 * Fetch a single audit entry.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @returns {Promise<Object>}
 */
export async function getById({ id } = {}) {
  const entry = await auditLogRepository.findById(id);
  if (!entry) throw ApiError.notFound('Audit entry not found');
  return entry;
}

/**
 * List audit entries for one module (e.g. `iam.tenants`).
 *
 * @param {Object} [opts]
 * @param {string} opts.module
 * @param {string} [opts.tenantId]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated audit list.
 */
export async function listByModule({ module, tenantId, page = 1, limit = 20 } = {}) {
  const filters = {};
  if (tenantId != null) filters.tenantId = tenantId;
  return auditLogRepository.listByModule(module, { filter: filters }, { page, limit });
}

/**
 * Request an asynchronous audit export. Delegates to `auditExport.service.js`
 * (lazy-imported to keep the module graph acyclic).
 *
 * @param {Object} opts - { tenantId, requestedBy, filters, format }.
 * @returns {Promise<Object>} { exportId, status: 'queued', format }.
 */
export async function requestExport(opts) {
  const { default: auditExport } = await import('./auditExport.service.js');
  return auditExport.requestExport(opts);
}

/**
 * Poll the status of an audit export. Delegates to `auditExport.service.js`.
 *
 * @param {Object} opts - { exportId, tenantId }.
 * @returns {Promise<Object>} export status row.
 */
export async function getExportStatus(opts) {
  const { default: auditExport } = await import('./auditExport.service.js');
  return auditExport.getExportStatus(opts);
}

/* ------------------------------ internals -------------------------------- */

/**
 * Recursively replace sensitive values with a redaction marker so secrets
 * never reach the append-only trail. Plain values pass through unchanged.
 *
 * @param {*} value
 * @returns {*}
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(val);
    }
    return out;
  }
  return value;
}

export default {
  emit,
  list,
  getById,
  listByModule,
  requestExport,
  getExportStatus,
  _meta: { appendOnly: true, redacts: [...SENSITIVE_KEYS] },
};
