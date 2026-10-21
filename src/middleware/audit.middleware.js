/**
 * audit.middleware.js (Sprint 2; roadmap 2.5 - denied-request audit).
 *
 * PURPOSE
 *   Request-level audit helpers. Model changes are recorded by the audit
 *   plugin and domain/security events by services; this module covers what
 *   only the HTTP layer knows.
 *
 * RESPONSIBILITY
 *   - `auditDenied(req, err, reason, details)` - called by authentication
 *     and authorization middleware (`auth`, `adminAuth`, `permission`,
 *     `denyIf`, `modulePermission`, `rbac`, `resolveTenant`,
 *     `tenantIsolation`, `apiKeyAuth`) right before they refuse a request
 *     with 401/403. Records a `request.denied` security event with the
 *     actor (or the verified token subject, or the API key), the tenant,
 *     the route pattern, the reason code and the client ip, then returns
 *     the error so the caller can `next()` it. Rate-limited: one row per
 *     (actor or ip, tenant, route, reason) per `AUDIT_DENIED_WINDOW_SEC`
 *     and at most `AUDIT_DENIED_MAX_PER_WINDOW` rows per process per
 *     window. Never delays or changes the response.
 *   - `audit(module, action)` - optional per-route request audit that emits
 *     after the response finishes (success OR failure). Not mounted by
 *     default: model rows, domain events and security events already cover
 *     mutations; use it for a route whose outcome is not otherwise audited.
 *
 * REASON CODES (auditDenied)
 *   no_identity, permission_missing, permission_denied_by_rule,
 *   no_permission_key, module_missing, role_missing, admin_type,
 *   cross_tenant, tenant_scope, account_suspended, account_not_active,
 *   tenant_not_active, session_inactive, token_invalid, api_key_invalid,
 *   api_key_scope, auditor_read_only and admin_scope (roadmap 2.1 platform
 *   admin read-only/tenant-scope refusals, `adminScope.middleware.js`).
 */

import auditLogService from '../services/auditLog.service.js';
import { securityEvent, takeDeniedBudget } from '../services/securityEvent.service.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { getActor } from './actor.js';

/** Path segments that are identifiers (ObjectId, UUID, long numbers, prefixed ids). */
const ID_SEGMENT = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}|[a-z]{2,5}_[A-Za-z0-9_-]{8,})$/i;

/** Replace identifier segments with `:id` (for paths without a route pattern). */
function generalise(path) {
  return path.split('/').map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment)).join('/');
}

/**
 * Route pattern (`GET /api/v1/dashboards/:id`), never the raw query string.
 * Inside a route the Express pattern is used; in router-level middleware
 * (no pattern yet) identifier segments are replaced by `:id`.
 */
export function routeOf(req) {
  // `baseUrl` is the matched path of the mount point, real ids included
  // (e.g. `/api/v1/tenants/<id>`), so it is always generalised; the route
  // pattern itself already names its parameters.
  const base = generalise(String(req.baseUrl ?? ''));
  const hasPattern = req.route?.path !== undefined && typeof req.route.path === 'string';
  const tail = hasPattern ? req.route.path : generalise(String(req.path ?? ''));
  const path = `${base}${tail === '/' && base ? '' : tail}`
    || generalise(String(req.originalUrl ?? req.url ?? '').split('?')[0]);
  return `${req.method ?? 'GET'} ${path}`;
}

/**
 * Tenant the request asked for (params, header, resolved tenant; body and
 * query only for an identified caller, so an anonymous request cannot file
 * rows under an arbitrary tenant).
 */
function requestedTenant(req, { identified = true } = {}) {
  const header = req.headers?.['x-tenant-id'];
  const candidates = [
    req.params?.tenantId,
    typeof header === 'string' ? header.trim() : null,
    req.tenant?.id ?? (typeof req.tenant === 'string' ? req.tenant : null),
    ...(identified ? [req.body?.tenantId, req.query?.tenantId] : []),
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 64) return value;
  }
  return null;
}

/** Who was refused: the authenticated actor, a verified token subject, or the API key. */
function deniedActor(req, err) {
  const actor = getActor(req);
  if (actor) return { type: actor.type, id: actor.id, display: actor.email ?? null, tenantId: actor.tenantId ?? null };
  if (err?.subject?.id) {
    return { type: err.subject.type, id: String(err.subject.id), display: null, tenantId: err.subject.tenantId ?? null };
  }
  if (req.apiKey?.keyId) {
    return { type: 'service', id: String(req.apiKey.keyId), display: 'api-key', tenantId: req.apiKey.tenantId ? String(req.apiKey.tenantId) : null };
  }
  return { type: 'system', id: null, display: 'anonymous', tenantId: null };
}

/**
 * Record a denied request (rate-limited, fire-and-forget) and hand the
 * error back.
 *
 * @param {import('express').Request} req
 * @param {Error & { statusCode?: number, code?: string }} err - the 401/403 about to be sent.
 * @param {string} reason - reason code (see header).
 * @param {Object} [details] - extra non-secret context (e.g. `{ permission }`);
 *   `requestedTenantId` names the tenant the request tried to reach when the
 *   caller knows it better than the request does (e.g. a custom param).
 * @returns {Error} `err`, unchanged.
 */
export function auditDenied(req, err, reason, details = {}) {
  try {
    const actor = deniedActor(req, err);
    const target = details.requestedTenantId
      ? String(details.requestedTenantId)
      : requestedTenant(req, { identified: Boolean(actor.id) });
    const actorTenant = actor.tenantId && actor.tenantId !== '*' ? String(actor.tenantId) : null;
    const tenantId = target ?? actorTenant;
    const route = routeOf(req);
    const ip = req.ip ?? null;
    const who = actor.id ? `${actor.type}:${actor.id}` : `ip:${ip ?? '-'}`;

    void securityEvent('REQUEST_DENIED', {
      actor,
      tenantId,
      resource: { type: 'route', id: route },
      reason,
      errorCode: err?.code ?? (err?.statusCode ? String(err.statusCode) : null),
      metadata: {
        route,
        statusCode: err?.statusCode ?? null,
        reason,
        requestedTenantId: target,
        actorTenantId: actor.tenantId ?? null,
        ...details,
      },
      ip,
      userAgent: req.headers?.['user-agent'] ?? null,
      requestId: req.id ?? null,
      dedupeKey: `${who}|${tenantId ?? '-'}|${route}|${reason}`,
      dedupeWindowSec: env.audit?.deniedWindowSec ?? 60,
      admit: () => takeDeniedBudget(),
      skipWhenOffline: true,
    });
  } catch (auditErr) {
    logger.error({ err: { message: auditErr?.message } }, '[audit] denied-request audit failed');
  }
  return err;
}

/** Resolve module/action, each of which may be a function of the request. */
function resolveDeclaration(req, moduleOrFn, actionOrFn) {
  const module = typeof moduleOrFn === 'function' ? moduleOrFn(req) : moduleOrFn;
  const action = typeof actionOrFn === 'function' ? actionOrFn(req) : actionOrFn;
  return { module: module ?? null, action: action ?? null };
}

/**
 * Factory: returns middleware that audits the request after it finishes.
 *
 * @param {string|(req) => string} moduleOrFn - e.g. `'iam.admins'`.
 * @param {string|(req) => string} actionOrFn - e.g. `'suspend'`.
 * @param {Object} [opts]
 * @param {string} [opts.tenantId] - override tenant when none is resolvable.
 * @returns {import('express').RequestHandler}
 */
export function audit(moduleOrFn, actionOrFn, opts = {}) {
  return (req, res, next) => {
    const { module, action } = resolveDeclaration(req, moduleOrFn, actionOrFn);

    res.on('finish', () => {
      // The actor is read at finish time: auth runs after this middleware.
      const actor = getActor(req);
      auditLogService
        .emit({
          actor: actor
            ? { type: actor.type, id: actor.id, display: actor.email }
            : { type: 'system', id: null, display: 'anonymous' },
          action,
          module,
          tenantId: req.tenant?.id ?? actor?.tenantId ?? opts.tenantId ?? null,
          reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
          result: res.statusCode >= 400 ? 'failure' : 'success',
          errorCode: res.statusCode >= 400 ? String(res.statusCode) : null,
          metadata: { route: routeOf(req), statusCode: res.statusCode },
          ip: req.ip ?? null,
          userAgent: req.headers?.['user-agent'] ?? null,
          requestId: req.id ?? null,
        })
        .catch((err) => {
          // Auditing must never break the response.
          logger.error({ err: { message: err?.message } }, '[audit] emit failed');
        });
    });

    return next();
  };
}

export default {
  audit,
  auditDenied,
  routeOf,
  _meta: {
    phase: '2.5 - denied-request audit',
    seeAlso: [
      'src/services/securityEvent.service.js',
      'src/constants/securityEvents.js',
      'src/routes/audit-log.routes.js',
    ],
  },
};
