/**
 * accessLog.middleware.js (Sprint 8 - implemented; roadmap 2.5 - API keys,
 * sign-in traffic, path without query string).
 *
 * PURPOSE
 *   Captures the identity-bearing HTTP traffic as `AccessLog` rows. Lives
 *   right after `requestId.middleware.js` at the top of the stack. Writes are
 *   buffered by `services/accessLog.service.js#capture` (flushed every
 *   2 s / 100 rows and on graceful shutdown).
 *
 * WHAT IS CAPTURED
 *   - Every request with an authenticated actor: user/admin (bearer JWT,
 *     `actorType` user/admin) and external API calls (`X-Api-Key`,
 *     `actorType: 'service'`, `actorId` = the key id, event `api_key`).
 *   - Every request to the sign-in surface (`/auth/*`, `/admin-auth/*`:
 *     login, refresh, logout, password reset, MFA, verification), whether it
 *     succeeded or failed, so failed logins are traced with ip and user
 *     agent. A successful login is attributed to the account that signed
 *     in; a failed one has no actor id (`actorType: 'system'`). Event
 *     `auth.<step>` (e.g. `auth.login`).
 *   - External API requests refused for a bad key (`event: api_key`).
 *   Other unauthenticated traffic (health checks, public embeds, inbound
 *   webhooks) is not captured: it carries no identity and the morgan log
 *   already has it.
 *
 * WHAT IS NEVER CAPTURED
 *   Request/response bodies, cookies, the Authorization / X-Api-Key headers,
 *   and the query string (`path` is the path only; query strings can carry
 *   tokens and personal data). The service allowlist drops anything else.
 *
 * USAGE
 *   ```
 *   app.use(accessLogMiddleware());   // after requestId, before routes
 *   ```
 */

import { getActor } from './actor.js';
import * as accessLogService from '../services/accessLog.service.js';
// observability: never store URL tokens (findings ops.13, ops2.04, api.08).
import { redactUrl } from '../utils/redact.js';

/** `/auth/<step>` or `/admin-auth/<step>` under any API prefix. */
const AUTH_PATH = /\/(admin-auth|auth)\/([a-z-]+)/i;
/** The external (API key) surface. */
const EXTERNAL_PATH = /\/external(\/|$)/i;

/** Path without the query string. */
function pathOf(req) {
  return String(req.originalUrl ?? req.url ?? '/').split('?')[0] || '/';
}

/**
 * Who to attribute the request to, or null to skip it.
 *
 * @returns {{ actor: { type: string, id: string|null, tenantId: string|null }, event?: string } | null}
 */
function attribution(req, res) {
  const actor = getActor(req);
  if (actor) return { actor };

  const path = pathOf(req);
  if (req.apiKey?.keyId) {
    return {
      actor: {
        type: 'service',
        id: String(req.apiKey.keyId),
        tenantId: req.apiKey.tenantId ? String(req.apiKey.tenantId) : null,
      },
      event: 'api_key',
    };
  }
  if (EXTERNAL_PATH.test(path)) {
    return { actor: { type: 'system', id: null, tenantId: null }, event: 'api_key' };
  }

  const auth = AUTH_PATH.exec(path);
  if (auth) {
    const step = auth[2].toLowerCase();
    // The login controller names the account that signed in.
    const signedIn = res.locals?.authActor ?? null;
    return {
      actor: signedIn
        ? { type: signedIn.type, id: String(signedIn.id), tenantId: signedIn.tenantId ?? null }
        : { type: 'system', id: null, tenantId: req.tenant?.id ?? null },
      event: `auth.${step}`,
    };
  }
  return null;
}

/**
 * Middleware factory. Captures the request on `res.finish`. The actor is
 * read at finish time because auth middleware runs at the route level
 * (after this global middleware). Never throws into the request path.
 *
 * @param {Object} [options]
 * @param {string} [options.event] - force an event tag for every capture.
 * @returns {import('express').RequestHandler}
 */
export function accessLog(options = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      try {
        const who = attribution(req, res);
        if (!who) return;

        const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
        const entry = {
          actorType: who.actor.type,
          actorId: who.actor.id,
          tenantId: who.actor.tenantId ?? null,
          method: req.method,
          path: redactUrl(pathOf(req)),
          statusCode: res.statusCode,
          latencyMs,
          ip: req.ip ?? null,
          userAgent: req.headers?.['user-agent'] ?? null,
          requestId: req.id ?? null,
          // support: the operator behind a read-only support session.
          impersonatedBy: who.actor.impersonatedBy ?? req.user?.impersonatedBy ?? null,
        };
        if (res.statusCode >= 400) {
          entry.error = {
            code: String(res.statusCode),
            message: res.statusMessage ?? null,
          };
        }
        const event = options.event ?? who.event;
        if (event) entry.event = event;
        accessLogService.capture(entry);
      } catch {
        // Telemetry must never affect the response.
      }
    });

    return next();
  };
}

export default {
  accessLog,
  _meta: {
    phase: '8 - implemented; 2.5 - API keys and sign-in traffic',
    mountOrder: 'global, right after requestId.middleware.js',
    seeAlso: ['src/services/accessLog.service.js'],
  },
};
