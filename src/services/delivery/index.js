/**
 * Delivery pipeline (delivery, roadmap 3.4) - contract owner.
 *
 * PURPOSE
 *   One pipeline for everything the platform sends outside the app:
 *   scheduled report artefacts, alert notifications and (later) audit
 *   streaming / security alerts. Each delivery to one recipient or one
 *   destination is a `DeliveryRun` row (the history), idempotent on
 *   `(tenantId, idempotencyKey)`.
 *
 * CONTRACT (contracts.md)
 *   deliver({ tenantId, kind, destination, payload, idempotencyKey }) -> { id, status }
 *     destination = { type: 'email', to, external? }
 *                 | { type: 'webhook'|'slack'|'teams', destinationId }
 *     payload     = { title, text, data, template, variables, attachments, sourceId, reportRunId }
 *   listDeliveries({ tenantId, sourceId?, status?, kind?, page?, limit? })
 *
 * TRANSPORTS
 *   - email: the durable outbox (`outbox.service.sendNow`), which owns
 *     SMTP retries; the run is `sent` once the outbox accepted it.
 *   - webhook / slack / teams: `transports.send` (egress guard + HMAC for
 *     webhooks). Transient failures are retried with exponential backoff by
 *     the `delivery-retry` job; permanent failures, or the last attempt,
 *     dead-letter the run (a member can retry it by hand).
 *
 * SECURITY
 *   Destination URLs and secrets are encrypted at rest and never returned
 *   or logged; errors stored on runs are sanitised codes/messages.
 */

import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import clock from '../../utils/clock.js';
import env from '../../config/env.js';
import { encryptSecret, decryptSecret } from '../../utils/crypto.js';
import * as outboxService from '../outbox.service.js';
import { computeBackoffMs } from '../outbox.service.js';
import { DeliveryRun, DELIVERY_TYPES } from '../../models/DeliveryRun.js';
import { DeliveryDestination, DESTINATION_TYPES } from '../../models/DeliveryDestination.js';
import { DeliveryUnsubscribe } from '../../models/DeliveryUnsubscribe.js';
import transports, { DeliveryTransportError } from './transports.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/* ------------------------------ destinations ----------------------------- */

function urlHint(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Create a destination. The URL is validated (https, egress guard) and
 * stored encrypted. Webhook destinations get a signing secret that is
 * returned ONCE in `signingSecret`.
 */
export async function createDestination({ tenantId, type, name, url, actorId = null } = {}) {
  if (!DESTINATION_TYPES.includes(type)) {
    throw ApiError.badRequest('Invalid destination', [{ field: 'type', message: `must be one of ${DESTINATION_TYPES.join(', ')}` }]);
  }
  if (!name || typeof name !== 'string') throw ApiError.badRequest('Invalid destination', [{ field: 'name', message: 'is required' }]);
  try {
    await transports.assertDestinationUrl(url);
  } catch (err) {
    throw ApiError.badRequest('Invalid destination URL', [{ field: 'url', message: err?.message || 'is not allowed' }]);
  }
  const signingSecret = type === 'webhook' ? crypto.randomBytes(32).toString('base64url') : null;
  const row = await DeliveryDestination.create({
    tenantId: String(tenantId), type, name: name.trim(), createdBy: actorId,
    urlEnc: encryptSecret(String(url)), secretEnc: signingSecret ? encryptSecret(signingSecret) : null,
    urlHint: urlHint(url),
  });
  const out = row.toJSON();
  return signingSecret ? { ...out, signingSecret } : out;
}

export async function listDestinations({ tenantId } = {}) {
  const rows = await DeliveryDestination.find({ tenantId: String(tenantId) }).sort({ createdAt: -1 });
  return rows.map((r) => r.toJSON());
}

export async function removeDestination({ tenantId, destinationId, actorId = null } = {}) {
  if (!OBJECT_ID_RE.test(String(destinationId))) throw ApiError.notFound('Destination not found');
  const row = await DeliveryDestination.findOne({ _id: destinationId, tenantId: String(tenantId) });
  if (!row) throw ApiError.notFound('Destination not found');
  await row.softDelete(actorId);
  return { id: String(row._id), deleted: true };
}

/** Verify every id is a destination of the tenant; returns the ids. */
export async function assertDestinationsOwned(tenantId, ids = [], field = 'destinationIds') {
  if (!Array.isArray(ids)) throw ApiError.badRequest('Invalid destinations', [{ field, message: 'must be an array of destination ids' }]);
  const unique = [...new Set(ids.map(String))];
  if (unique.some((id) => !OBJECT_ID_RE.test(id))) throw ApiError.badRequest('Invalid destinations', [{ field, message: 'must be destination ids' }]);
  if (!unique.length) return [];
  const found = await DeliveryDestination.countDocuments({ tenantId: String(tenantId), _id: { $in: unique } });
  if (found !== unique.length) throw ApiError.badRequest('Invalid destinations', [{ field, message: 'must be destinations of this workspace' }]);
  return unique;
}

/* ------------------------------ unsubscribe ------------------------------ */

function unsubscribeSig(body) {
  return crypto.createHmac('sha256', `${env.security.jwtSecret}:delivery-unsubscribe`).update(body).digest('base64url');
}

/** Signed, non-expiring unsubscribe token for (tenant, email). */
export function unsubscribeToken(tenantId, email) {
  const body = Buffer.from(JSON.stringify({ t: String(tenantId), e: String(email).toLowerCase() })).toString('base64url');
  return `${body}.${unsubscribeSig(body)}`;
}

export function unsubscribeUrl(tenantId, email) {
  return `${env.cors.clientUrl}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(tenantId, email))}`;
}

/** Record an opt-out from a token. Throws 400 on a bad token. */
export async function unsubscribe({ token } = {}) {
  const [body, sig] = String(token || '').split('.');
  const expected = body ? unsubscribeSig(body) : '';
  if (!body || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw ApiError.badRequest('Invalid unsubscribe link');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw ApiError.badRequest('Invalid unsubscribe link'); }
  await DeliveryUnsubscribe.updateOne(
    { tenantId: parsed.t, email: parsed.e },
    { $setOnInsert: { tenantId: parsed.t, email: parsed.e } },
    { upsert: true },
  );
  return { unsubscribed: true };
}

async function isUnsubscribed(tenantId, email) {
  return Boolean(await DeliveryUnsubscribe.exists({ tenantId: String(tenantId), email: String(email).toLowerCase() }));
}

/* -------------------------------- pipeline ------------------------------- */

function errorText(err) {
  if (err instanceof DeliveryTransportError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err?.code === 'ATTACHMENT_MISSING') return 'ATTACHMENT_MISSING: the report file is no longer available';
  return 'DELIVERY_FAILED: the delivery could not be completed';
}

async function attemptEmail(run) {
  const p = run.payload || {};
  if (run.external && await isUnsubscribed(run.tenantId, run.recipient)) return { status: 'skipped', lastError: 'UNSUBSCRIBED: recipient opted out' };
  const variables = { ...(p.variables || {}) };
  if (run.external) variables.unsubscribeUrl = unsubscribeUrl(run.tenantId, run.recipient);
  // delivery: interactive send via the outbox (falls back to outbox retries on failure).
  const res = await outboxService.sendNow({
    tenantId: run.tenantId,
    to: run.recipient,
    template: p.template,
    variables,
    attachments: p.attachments || [],
    idempotencyKey: `delivery:${String(run._id)}`,
  });
  // The outbox owns SMTP retries once it has recorded the message.
  return { status: 'sent', outboxId: res.id };
}

async function attemptDestination(run) {
  const dest = await DeliveryDestination.findOne({ _id: run.destinationId, tenantId: run.tenantId }).select('+urlEnc +secretEnc');
  if (!dest) throw new DeliveryTransportError('DESTINATION_REMOVED', 'Destination no longer exists');
  const p = run.payload || {};
  const body = transports.formatBody(dest.type, { kind: run.kind, deliveryId: String(run._id), title: p.title, text: p.text, data: p.data });
  await transports.send({
    type: dest.type,
    url: decryptSecret(dest.urlEnc),
    secret: dest.secretEnc ? decryptSecret(dest.secretEnc) : null,
    body,
  });
  return { status: 'sent' };
}

/** One attempt; persists the outcome. Never throws. */
async function attempt(run, now = clock.now()) {
  const attempts = (run.attempts || 0) + 1;
  let patch;
  try {
    const out = run.destinationType === 'email' ? await attemptEmail(run) : await attemptDestination(run);
    patch = { ...out, attempts, lastAttemptAt: now, nextAttemptAt: null, ...(out.status === 'sent' ? { sentAt: now, lastError: null } : {}) };
  } catch (err) {
    const transient = err instanceof DeliveryTransportError ? err.transient : err?.code !== 'ATTACHMENT_MISSING';
    const lastError = errorText(err);
    if (!(err instanceof DeliveryTransportError)) logger.warn({ err: { message: err?.message, code: err?.code }, deliveryId: String(run._id) }, 'delivery attempt failed');
    patch = transient && attempts < (run.maxAttempts || env.delivery.maxAttempts)
      ? { status: 'retrying', attempts, lastAttemptAt: now, lastError, nextAttemptAt: new Date(now.getTime() + computeBackoffMs(attempts)) }
      : { status: 'dead', attempts, lastAttemptAt: now, lastError, nextAttemptAt: null, deadAt: now };
  }
  return DeliveryRun.findOneAndUpdate({ _id: run._id, tenantId: run.tenantId }, { $set: patch }, { new: true });
}

/**
 * Deliver one payload to one destination (see CONTRACT). Idempotent: the
 * same key returns the existing run without sending again.
 */
export async function deliver({ tenantId, kind, destination = {}, payload = {}, idempotencyKey } = {}) {
  if (!tenantId || !kind || !idempotencyKey) throw ApiError.badRequest('tenantId, kind and idempotencyKey are required');
  const type = destination.type;
  if (!DELIVERY_TYPES.includes(type)) throw ApiError.badRequest('Invalid delivery destination type');
  if (type === 'email' && !EMAIL_RE.test(String(destination.to || ''))) throw ApiError.badRequest('Invalid delivery recipient');
  if (type !== 'email' && !OBJECT_ID_RE.test(String(destination.destinationId || ''))) throw ApiError.badRequest('Invalid delivery destination');

  const existing = await DeliveryRun.findOne({ tenantId: String(tenantId), idempotencyKey });
  if (existing) return { id: String(existing._id), status: existing.status, duplicate: true };

  let label = '';
  let destinationType = type;
  if (type !== 'email') {
    const dest = await DeliveryDestination.findOne({ _id: destination.destinationId, tenantId: String(tenantId) });
    label = dest ? dest.name : '';
    // The stored destination decides the wire format (webhook / Slack / Teams).
    if (dest) destinationType = dest.type;
  }
  let run;
  try {
    run = await DeliveryRun.create({
      tenantId: String(tenantId), kind, idempotencyKey,
      sourceId: payload.sourceId ? String(payload.sourceId) : null,
      reportRunId: payload.reportRunId ? String(payload.reportRunId) : null,
      destinationType,
      destinationId: type === 'email' ? null : String(destination.destinationId),
      recipient: type === 'email' ? String(destination.to).toLowerCase() : label,
      external: type === 'email' ? Boolean(destination.external) : false,
      maxAttempts: env.delivery.maxAttempts,
      payload,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await DeliveryRun.findOne({ tenantId: String(tenantId), idempotencyKey });
      return { id: String(dup._id), status: dup.status, duplicate: true };
    }
    throw err;
  }
  const done = await attempt(run);
  return { id: String(done._id), status: done.status };
}

/** Paginated delivery history of a tenant, newest first. */
export async function listDeliveries({ tenantId, sourceId, status, kind, page = 1, limit = 20 } = {}) {
  const filter = { tenantId: String(tenantId) };
  if (sourceId) filter.sourceId = String(sourceId);
  if (status) filter.status = String(status);
  if (kind) filter.kind = String(kind);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const [docs, total] = await Promise.all([
    DeliveryRun.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l),
    DeliveryRun.countDocuments(filter),
  ]);
  return { docs: docs.map((d) => d.toJSON()), total, page: p, limit: l };
}

/** Manual retry of a dead (or retrying) delivery: one attempt now. */
export async function retryDelivery({ tenantId, deliveryId } = {}) {
  if (!OBJECT_ID_RE.test(String(deliveryId))) throw ApiError.notFound('Delivery not found');
  const run = await DeliveryRun.findOne({ _id: deliveryId, tenantId: String(tenantId) });
  if (!run) throw ApiError.notFound('Delivery not found');
  if (!['dead', 'retrying'].includes(run.status)) throw ApiError.conflict('Only failed deliveries can be retried');
  // A manual retry gets a fresh attempt budget.
  const claimed = await DeliveryRun.findOneAndUpdate(
    { _id: run._id, tenantId: run.tenantId, status: run.status },
    { $set: { status: 'pending', attempts: 0, deadAt: null } },
    { new: true },
  );
  if (!claimed) throw ApiError.conflict('Delivery is already being retried');
  return (await attempt(claimed)).toJSON();
}

/** Job: retry every delivery whose backoff elapsed. */
export async function retryDue({ now = clock.now(), limit = 50 } = {}) {
  let retried = 0;
  for (let i = 0; i < limit; i += 1) {
    // Claim atomically (status flip) so two instances never send twice.
    const run = await DeliveryRun.findOneAndUpdate(
      { status: 'retrying', nextAttemptAt: { $lte: now } },
      { $set: { status: 'pending' } },
      { new: true, sort: { nextAttemptAt: 1 } },
    );
    if (!run) break;
    await attempt(run, now);
    retried += 1;
  }
  return { retried };
}

export default {
  deliver, listDeliveries, retryDelivery, retryDue,
  createDestination, listDestinations, removeDestination, assertDestinationsOwned,
  unsubscribe, unsubscribeToken, unsubscribeUrl,
};
