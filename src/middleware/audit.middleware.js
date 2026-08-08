/**
 * audit.middleware.js (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Records every auditable request into `governance/audit-logs/`. Does NOT
 *   check permissions; it only observes. Sensitive payloads are redacted by
 *   `services/auditLog.service#emit` before persistence.
 *
 * RESPONSIBILITY
 *   - Capture actor, action, module (static or derived from the request),
 *     reason (from `req.body.reason`), ip, userAgent, requestId, result.
 *   - Emit AFTER the route handler finishes (success OR failure) by hooking
 *     `res.on('finish')`, so refusals (4xx) are audited too.
 *   - Never interfere with the response: a failing audit write is logged,
 *     never thrown into the request path.
 *
 * USAGE
 *   ```
 *   router.post(
 *     '/:id/suspend',
 *     audit('iam.admins', 'suspend'),       // captures reason from req.body
 *     controller.suspendAdmin
 *   );
 *   ```
 */

import auditLogService from '../services/auditLog.service.js';
import { getActor } from './actor.js';

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
    const actor = getActor(req);

    res.on('finish', () => {
      auditLogService
        .emit({
          actor: actor
            ? { type: actor.type, id: actor.id, display: actor.email }
            : { type: 'system', id: null, display: 'anonymous' },
          action,
          module,
          tenantId: req.tenant?.id ?? actor?.tenantId ?? opts.tenantId ?? null,
          reason: req.body?.reason ?? null,
          result: res.statusCode >= 400 ? 'failure' : 'success',
          errorCode: res.statusCode >= 400 ? String(res.statusCode) : null,
          ip: req.ip ?? null,
          userAgent: req.headers?.['user-agent'] ?? null,
          requestId: req.id ?? null,
        })
        .catch((err) => {
          // Auditing must never break the response.
          /* eslint-disable-next-line no-console */
          console.error('[audit] emit failed', err?.message);
        });
    });

    return next();
  };
}

export default {
  audit,
  _meta: {
    phase: '2 - implemented',
    seeAlso: [
      'src/services/auditLog.service.js',
      'src/routes/audit-log.routes.js',
    ],
  },
};
