/**
 * Audit Log Service (Sprint 2 - implemented; roadmap 2.5 - categories,
 * serialisation, hash chain).
 *
 * PURPOSE
 *   Single write entry point for audit events, plus the read surface for
 *   the `/audit-logs` API. Writes MUST go through `emit` so the event
 *   shape stays consistent, payloads are serialised and redacted, and every
 *   row is sealed into the hash chain (`repositories/auditLog.repository.js`).
 *
 * RESPONSIBILITY
 *   - emit({ actor, action, module, category, severity, resource, before,
 *     after, metadata, reason, ... })
 *   - list(filters) / getById / listByModule
 *
 * CODING GUIDELINES
 *   - Payloads (`before`, `after`, `metadata`) are turned into plain JSON
 *     (`utils/auditPayload.js#toAuditValue`): dates become ISO strings,
 *     ObjectIds hex strings, and any credential-like key (password, secret,
 *     *Hash, *Token, API key, cookie, authorization, MFA material) is
 *     replaced with `[REDACTED]` BEFORE persistence. Model rows are further
 *     reduced to per-model allow-lists by the audit consumer.
 *   - `ip`, `userAgent` and `requestId` default to the current request
 *     context (`utils/actorContext.js`), so service-level events carry the
 *     network context without threading `req` through every signature.
 *   - Security events use `services/securityEvent.service.js`, which calls
 *     this with `category: 'security'`.
 *   - All reads filter by tenant unless the actor is a platform admin
 *     (the controller enforces that; the service accepts a tenant filter).
 *   - Export requests live in `services/auditExport.service.js`
 *     (`src/queues/` -> `src/storage/`); this module stays read/write for
 *     the trail only.
 */

import ApiError from '../utils/ApiError.js';
import auditLogRepository from '../repositories/auditLog.repository.js';
import { buildAuditFilter } from '../utils/auditFilters.js';
import { toAuditValue, isSensitiveKey } from '../utils/auditPayload.js';
import { getCurrentRequestMeta, getCurrentActor } from '../utils/actorContext.js';
import { AUDIT_CATEGORIES, SECURITY_SEVERITIES } from '../constants/securityEvents.js';

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);
const RESULTS = new Set(['success', 'failure']);
const CATEGORIES = new Set(AUDIT_CATEGORIES);
const SEVERITIES = new Set(SECURITY_SEVERITIES);

/** Longest free-text value stored in a scalar column. */
const MAX_TEXT = 1000;

/** Scalar column value: strings/numbers/ObjectIds as a capped string, else null. */
function scalar(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value?._bsontype === 'ObjectId' || value?._bsontype === 'ObjectID') return value.toHexString();
  return null;
}

/**
 * Append an audit event to the trail. Validates the shape, serialises and
 * redacts `before`/`after`/`metadata`, and persists via the repository
 * (which seals the row into the hash chain).
 *
 * @param {Object} opts
 * @param {{ type: 'admin'|'user'|'service'|'system', id: string, display?: string }} opts.actor
 * @param {string} opts.action
 * @param {string} opts.module - e.g. `iam.roles`, `iam.tenants`.
 * @param {'change'|'security'} [opts.category='change']
 * @param {'info'|'notice'|'warning'|'critical'|null} [opts.severity=null]
 * @param {{ type?: string, id?: string }} [opts.resource]
 * @param {*} [opts.before]
 * @param {*} [opts.after]
 * @param {*} [opts.metadata] - structured details (operation, counts, ids).
 * @param {string} [opts.reason]
 * @param {string} [opts.tenantId]
 * @param {'success'|'failure'} [opts.result='success']
 * @param {string} [opts.errorCode]
 * @param {string} [opts.ip] - defaults to the request context.
 * @param {string} [opts.userAgent] - defaults to the request context.
 * @param {string} [opts.requestId] - defaults to the request context.
 * @returns {Promise<Object>} saved event (plain).
 */
export async function emit({
  actor,
  action,
  module,
  category = 'change',
  severity = null,
  resource,
  before,
  after,
  metadata,
  reason,
  tenantId,
  result = 'success',
  errorCode,
  ip,
  userAgent,
  requestId,
  impersonatedBy,
} = {}) {
  if (!actor || !ACTOR_TYPES.has(actor.type)) {
    throw ApiError.badRequest('actor.type must be one of admin, user, service, system');
  }
  if (!action || typeof action !== 'string') throw ApiError.badRequest('action is required');
  if (!module || typeof module !== 'string') throw ApiError.badRequest('module is required');
  if (result && !RESULTS.has(result)) {
    throw ApiError.badRequest('result must be "success" or "failure"');
  }
  if (!CATEGORIES.has(category)) throw ApiError.badRequest('category must be "change" or "security"');
  if (severity !== null && severity !== undefined && !SEVERITIES.has(severity)) {
    throw ApiError.badRequest(`severity must be one of ${SECURITY_SEVERITIES.join(', ')}`);
  }

  const context = getCurrentRequestMeta();
  return auditLogRepository.insert({
    category,
    severity: severity ?? null,
    actorType: actor.type,
    actorId: scalar(actor.id),
    actorDisplay: scalar(actor.display, 320),
    tenantId: scalar(tenantId),
    module,
    action,
    resourceType: scalar(resource?.type),
    resourceId: scalar(resource?.id),
    before: toAuditValue(before ?? null) ?? null,
    after: toAuditValue(after ?? null) ?? null,
    metadata: toAuditValue(metadata ?? null) ?? null,
    reason: scalar(reason),
    result,
    errorCode: scalar(errorCode, 120),
    ip: scalar(ip ?? context.ip, 100),
    userAgent: scalar(userAgent ?? context.userAgent, 512),
    requestId: scalar(requestId ?? context.requestId, 128),
    impersonatedBy: resolveImpersonatedBy(impersonatedBy, actor),
  });
}

/**
 * support: the operator behind the write, if any - explicit value first,
 * then the actor object, then the authenticated request context.
 */
function resolveImpersonatedBy(explicit, actor) {
  const value = explicit ?? actor?.impersonatedBy ?? getCurrentActor()?.impersonatedBy ?? null;
  return value ? String(value) : null;
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
 * @param {'change'|'security'} [opts.category]
 * @param {'info'|'notice'|'warning'|'critical'} [opts.severity]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated audit list.
 */
export async function list({
  tenantId,
  category,
  severity,
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
    category,
    severity,
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
 * Fetch a single audit entry. With `tenantId`, an entry of another tenant
 * is reported as not found.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string|null} [opts.tenantId]
 * @returns {Promise<Object>}
 */
export async function getById({ id, tenantId = null } = {}) {
  const key = id == null ? '' : String(id);
  if (!/^[0-9a-fA-F]{24}$/.test(key)) throw ApiError.notFound('Audit entry not found');
  const entry = await auditLogRepository.findById(key);
  if (!entry) throw ApiError.notFound('Audit entry not found');
  if (tenantId && String(entry.tenantId ?? '') !== String(tenantId)) throw ApiError.notFound('Audit entry not found');
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

export default {
  emit,
  list,
  getById,
  listByModule,
  requestExport,
  getExportStatus,
  _meta: { appendOnly: true, hashChained: true, redacts: 'utils/auditPayload.isSensitiveKey', isSensitiveKey },
};
