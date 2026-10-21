/**
 * Security Event Service (roadmap 2.5; findings gov.06, gov.08).
 *
 * PURPOSE
 *   One small, reusable way to record a security event:
 *
 *     await securityEvent('LOGIN_FAILED', { actor, tenantId, reason, metadata });
 *
 *   It writes an `AuditLog` row with `category: 'security'` and the module,
 *   action, severity and default result defined for the event in
 *   `constants/securityEvents.js` (the one place event names live). Rows are
 *   hash-chained and appear in the admin audit viewer's "Security" filter.
 *
 * WHAT IT FILLS IN
 *   - actor: the given `actor`, else the identity of the current request
 *     (`utils/actorContext.js`), else `system`.
 *   - tenantId: the given value (null is kept), else the actor's tenant.
 *   - ip / userAgent / requestId: the given values, else the request
 *     context. Background work has none.
 *
 * GUARANTEES
 *   - Never throws for an operational failure (database, cache): the event
 *     is logged and the business flow carries on. An unknown event key IS a
 *     programming error and throws.
 *   - No secrets: `metadata` goes through the audit serialiser, which
 *     redacts credential-like keys (password, secret, *Hash, *Token, API
 *     key, cookie, authorization, MFA material). Pass ids and reasons, never
 *     tokens.
 *   - Optional de-duplication (`dedupeKey` + `dedupeWindowSec`): one row per
 *     key per window, shared across instances when Redis backs the cache.
 *     Used for failed logins and denied requests so neither can flood the
 *     trail.
 *
 * USED BY
 *   auth (login, lockout, refresh-token replay), password reset, MFA,
 *   sessions, roles/permissions, admin privileges, support impersonation,
 *   API keys, embed tokens, and `middleware/audit.middleware.js#auditDenied`
 *   (denied requests). Later packages (admin MFA recovery codes, detection
 *   rules) call it the same way after adding their event to the catalogue.
 */

import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import * as cacheService from './cache.service.js';
import { emit } from './auditLog.service.js';
import { getCurrentActor, getCurrentRequestMeta } from '../utils/actorContext.js';
import { SECURITY_EVENTS } from '../constants/securityEvents.js';

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);
const DEDUPE_PREFIX = 'audit:security:dedupe:';

/**
 * In-process de-duplication (no Redis, or Redis unavailable): key ->
 * expiresAt. Bounded: the in-memory cache driver only drops an expired key
 * when that same key is read again, so attacker-chosen keys (failed logins
 * with random emails, forged tokens from many ips) would pile up there
 * forever. This map sweeps expired entries when it fills up.
 */
const localDedupe = new Map();
const LOCAL_DEDUPE_MAX = 10000;

/** Resolve an event key (`'LOGIN_FAILED'`) or definition object. */
function resolveEvent(event) {
  if (typeof event === 'string') {
    const def = SECURITY_EVENTS[event];
    if (!def) throw new TypeError(`Unknown security event "${event}" (see constants/securityEvents.js)`);
    return def;
  }
  if (event && Object.values(SECURITY_EVENTS).includes(event)) return event;
  throw new TypeError('securityEvent() needs a key from constants/securityEvents.js');
}

/** A tenant id worth recording (the admin cross-tenant scope `*` is not one). */
function realTenant(value) {
  if (value === undefined || value === null || value === '' || value === '*') return null;
  return String(value);
}

function resolveActor(actor) {
  const source = actor ?? getCurrentActor();
  if (source && ACTOR_TYPES.has(source.type)) {
    return {
      type: source.type,
      id: source.id != null ? String(source.id) : null,
      display: source.display ?? source.email ?? null,
      tenantId: source.tenantId ?? null,
    };
  }
  return { type: 'system', id: null, display: null, tenantId: null };
}

/** The shared cache spans instances (and expires keys itself) only on Redis. */
function sharedCacheIsRedis() {
  try {
    return cacheService.getDriver()?.provider === 'redis';
  } catch {
    return false;
  }
}

/** Claim a slot in the bounded in-process map. */
function claimLocal(digest, ttlSec, now = Date.now()) {
  const until = localDedupe.get(digest);
  if (until && until > now) return false;
  if (localDedupe.size >= LOCAL_DEDUPE_MAX) {
    for (const [key, expiresAt] of localDedupe) {
      if (expiresAt <= now) localDedupe.delete(key);
    }
    // Still full of live keys: start over rather than grow (the per-process
    // budget still caps what reaches the trail).
    if (localDedupe.size >= LOCAL_DEDUPE_MAX) localDedupe.clear();
  }
  localDedupe.set(digest, now + ttlSec * 1000);
  return true;
}

/**
 * Claim a de-duplication slot. True when this call is the first for `key`
 * inside the window. Redis makes the window shared across instances; without
 * it the bounded in-process map is used (never the in-memory cache, which
 * would keep every distinct key forever).
 */
async function claimDedupe(key, windowSec) {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 40);
  const ttl = Math.max(1, Math.floor(windowSec));
  if (!sharedCacheIsRedis()) return claimLocal(digest, ttl);
  try {
    return await cacheService.setIfAbsent(`${DEDUPE_PREFIX}${digest}`, 1, ttl);
  } catch {
    return claimLocal(digest, ttl);
  }
}

/** Test helper: number of keys held by the in-process de-dupe map. */
export function localDedupeSize() {
  return localDedupe.size;
}

/**
 * Record a security event.
 *
 * @param {string|Object} event - key of `SECURITY_EVENTS` (e.g. `'LOGIN_FAILED'`).
 * @param {Object} [details]
 * @param {{ type: string, id?: string|null, display?: string|null, email?: string|null, tenantId?: string|null }} [details.actor]
 * @param {string|null} [details.tenantId] - defaults to the actor's tenant.
 * @param {{ type?: string, id?: string }} [details.resource]
 * @param {'success'|'failure'} [details.result] - defaults to the event's.
 * @param {string} [details.reason]
 * @param {string} [details.errorCode]
 * @param {Object} [details.metadata] - ids, reasons, counts. No secrets.
 * @param {string} [details.ip]
 * @param {string} [details.userAgent]
 * @param {string} [details.requestId]
 * @param {string} [details.dedupeKey] - one row per key per window.
 * @param {number} [details.dedupeWindowSec=60]
 * @param {() => boolean} [details.admit] - last gate after de-duplication
 *   (e.g. a per-process budget); returning false drops the event.
 * @param {boolean} [details.skipWhenOffline=false] - drop the event instead
 *   of waiting for the database when it is not connected (fire-and-forget
 *   callers such as the denied-request audit).
 * @returns {Promise<Object|null>} the stored row, or null when suppressed
 *   by de-duplication or when the write failed (logged).
 */
export async function securityEvent(event, details = {}) {
  const def = resolveEvent(event);
  const {
    actor,
    tenantId,
    resource,
    result,
    reason,
    errorCode,
    metadata,
    ip,
    userAgent,
    requestId,
    dedupeKey,
    dedupeWindowSec = 60,
    admit,
    skipWhenOffline = false,
  } = details;

  try {
    if (skipWhenOffline && mongoose.connection.readyState !== 1) return null;
    if (dedupeKey) {
      const first = await claimDedupe(`${def.action}|${dedupeKey}`, dedupeWindowSec);
      if (!first) return null;
    }
    if (typeof admit === 'function' && !admit()) return null;
    const who = resolveActor(actor);
    const context = getCurrentRequestMeta();
    return await emit({
      category: 'security',
      severity: def.severity,
      module: def.module,
      action: def.action,
      actor: { type: who.type, id: who.id, display: who.display },
      tenantId: tenantId !== undefined ? realTenant(tenantId) : realTenant(who.tenantId),
      resource,
      result: result ?? def.result,
      reason,
      errorCode,
      metadata: metadata ?? null,
      ip: ip || context.ip || null,
      userAgent: userAgent || context.userAgent || null,
      requestId: requestId || context.requestId || null,
    });
  } catch (err) {
    logger.error({ err: { message: err?.message }, event: def.action }, '[security-event] write failed');
    return null;
  }
}

/* ----------------------------- denied requests ---------------------------- */

/** Per-process ceiling on denied-request rows per window: { windowStart, count }. */
const deniedBudget = { windowStart: 0, count: 0 };

/**
 * Take one slot from the per-process denied-request budget
 * (`AUDIT_DENIED_MAX_PER_WINDOW` rows per `AUDIT_DENIED_WINDOW_SEC`).
 *
 * @returns {boolean}
 */
export function takeDeniedBudget(now = Date.now()) {
  const windowMs = Math.max(1, Number(env.audit?.deniedWindowSec) || 60) * 1000;
  const max = Math.max(0, Number(env.audit?.deniedMaxPerWindow) || 0);
  if (now - deniedBudget.windowStart >= windowMs) {
    deniedBudget.windowStart = now;
    deniedBudget.count = 0;
  }
  if (deniedBudget.count >= max) return false;
  deniedBudget.count += 1;
  return true;
}

/** Test helper: reset the per-process budget and the local de-dupe map. */
export function resetSecurityEventLimits() {
  deniedBudget.windowStart = 0;
  deniedBudget.count = 0;
  localDedupe.clear();
}

export default {
  securityEvent,
  takeDeniedBudget,
  resetSecurityEventLimits,
  localDedupeSize,
  SECURITY_EVENTS,
};
