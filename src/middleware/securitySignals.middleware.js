/**
 * Security signals middleware (roadmap 2.6 - platform security detection).
 *
 * WHY IT EXISTS
 *   Feeds the request-level detection rules (API-key misuse, rate-limit
 *   hits, request volume, webhook authentication failures) without touching
 *   the authentication or rate-limit middleware: it only OBSERVES each
 *   finished response and counts it through
 *   `services/securityDetection/signals.js` (per-minute counters, flushed in
 *   batches).
 *
 * WHAT IS COUNTED (on `finish`)
 *   - api_key.request       a call authenticated with an API key (key id,
 *                           status, client range)
 *   - api_key.auth_failed   a 401 for a request that presented an
 *                           `X-Api-Key`: only the key's PUBLIC prefix (the
 *                           part before the dot) is kept, never the secret
 *   - rate_limit.hit        a 429, per tenant when the caller is known,
 *                           otherwise per client range
 *   - tenant.request        every request of an authenticated tenant caller
 *                           (user or API key)
 *   - connector.auth_failed a 401/403 on the inbound webhook surface for a
 *                           known webhook connector (resolved in memory; the
 *                           URL token is never stored)
 *   - webhook.unknown_token the same for tokens that match no connector,
 *                           per client range
 *
 * POSITION
 *   Global, right after the access-log middleware (before the rate limiter,
 *   so 429s are observed too).
 */

import env from '../config/env.js';
import { getActor } from './actor.js';
import { record } from '../services/securityDetection/signals.js';
import { ipRange } from '../services/securityDetection/util.js';
import connectorRepository from '../repositories/connector.repository.js';

const API_KEY_PREFIX_RE = /^[A-Za-z0-9_-]{4,64}$/;
// Same shape the webhook service accepts; anything else matches no connector.
const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
/** Concurrent webhook-token lookups allowed (refused deliveries only). */
const MAX_TOKEN_LOOKUPS = 20;
let tokenLookups = 0;

function realTenant(value) {
  if (value === undefined || value === null || value === '' || value === '*') return null;
  return String(value);
}

function apiKeyPrefix(req) {
  const header = req.headers?.['x-api-key'];
  if (typeof header !== 'string' || header.length === 0) return null;
  const prefix = header.split('.')[0];
  return API_KEY_PREFIX_RE.test(prefix) ? prefix : null;
}

/** The token segment of an inbound webhook path (`undefined` off that surface). */
function webhookToken(req) {
  const base = `${env.app.apiPrefix}/webhooks/`;
  const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  if (!path.startsWith(base)) return undefined;
  return path.slice(base.length).split('/')[0];
}

/** Attribute a refused webhook delivery to its connector (async, bounded). */
function recordWebhookRefusal(token, { status, range }) {
  if (!WEBHOOK_TOKEN_RE.test(token) || tokenLookups >= MAX_TOKEN_LOOKUPS) {
    record({ kind: 'webhook.unknown_token', subject: `ip:${range ?? 'unknown'}`, status, ipRange: range });
    return;
  }
  tokenLookups += 1;
  Promise.resolve()
    .then(() => connectorRepository.findByWebhookToken(token))
    .then((connector) => {
      if (connector && connector.type === 'webhook') {
        record({
          kind: 'connector.auth_failed',
          subject: String(connector._id),
          tenantId: connector.tenantId ?? null,
          status,
          ipRange: range,
        });
      } else {
        record({ kind: 'webhook.unknown_token', subject: `ip:${range ?? 'unknown'}`, status, ipRange: range });
      }
    })
    .catch(() => {})
    .finally(() => {
      tokenLookups -= 1;
    });
}

/** Count one finished response. Never throws. */
export function observe(req, res) {
  const status = Number(res.statusCode) || 0;
  const range = ipRange(req.ip ?? req.socket?.remoteAddress ?? null);
  const actor = getActor(req);
  const keyId = req.apiKey?.keyId ? String(req.apiKey.keyId) : null;
  const tenantId = realTenant(req.apiKey?.tenantId ?? (actor?.type === 'user' ? actor.tenantId : null));
  const caller = keyId ? `api_key:${keyId}` : actor ? `${actor.type}:${actor.id}` : null;

  if (keyId) {
    record({ kind: 'api_key.request', subject: keyId, tenantId, status, ipRange: range });
  } else if (status === 401) {
    const prefix = apiKeyPrefix(req);
    if (prefix) record({ kind: 'api_key.auth_failed', subject: prefix, status, ipRange: range });
  }

  if (status === 429) {
    record({
      kind: 'rate_limit.hit',
      subject: tenantId ? `tenant:${tenantId}` : `ip:${range ?? 'unknown'}`,
      tenantId,
      status,
      ipRange: range,
      actor: caller,
    });
  }

  if (tenantId) {
    record({ kind: 'tenant.request', subject: tenantId, tenantId, status, ipRange: range, actor: caller });
  }

  if (status === 401 || status === 403) {
    const token = webhookToken(req);
    if (token !== undefined) recordWebhookRefusal(token, { status, range });
  }
}

/**
 * Middleware factory. A no-op when SECURITY_SIGNALS_ENABLED=false.
 *
 * @returns {import('express').RequestHandler}
 */
export function securitySignals() {
  if (env.securityDetection?.signals?.enabled === false) {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    res.on('finish', () => {
      try {
        observe(req, res);
      } catch {
        // Telemetry must never affect the request.
      }
    });
    next();
  };
}

export default { securitySignals, observe };
