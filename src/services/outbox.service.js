/**
 * Email outbox (roadmap 2.7; contract owner: retention).
 *
 * WHY IT EXISTS
 *   Email used to be sent inline in request handlers with no retry: an SMTP
 *   blip lost the message, a slow SMTP egress held the request open. The
 *   outbox makes every message a durable `OutboundEmail` record that the
 *   email job drains with retries and exponential backoff, dead-letters
 *   after `OUTBOX_MAX_ATTEMPTS`, and de-duplicates by idempotency key.
 *
 * CONTRACT (binding for other packages)
 *   enqueueEmail({ tenantId = null, to, template, variables = {}, idempotencyKey, attachments = [] })
 *     -> { id, status }
 *   Non-interactive mail (alerts, reports, notices) uses this.
 *
 *   sendNow(sameParams) -> { id, status, delivered, accepted, rejected, error }
 *   Interactive mail (verification, password reset, invitations): the
 *   message is recorded first, then one attempt is made within the request;
 *   if it fails the outbox retries it later (outbox fallback).
 *
 * GUARANTEES
 *   - One record per (tenant, idempotencyKey): re-enqueueing returns the
 *     existing record and never sends a second copy.
 *   - A message is claimed atomically before it is sent, so concurrent
 *     drains never send it twice. Delivery is at-least-once only across a
 *     crash between the SMTP accept and the `sent` write; each record sends
 *     with a stable Message-ID so receivers can de-duplicate that case.
 *   - Template variables are encrypted at rest and dropped once sent.
 *   - Errors stored on the record are sanitised (no stack, no credentials).
 */

import { createHash, randomUUID } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import clock from '../utils/clock.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import { getInstanceId } from '../jobs/runtime.js';
import outboxRepository from '../repositories/outboundEmail.repository.js';
import { OUTBOX_STATUSES } from '../models/OutboundEmail.js';
import * as emailService from './email.service.js';
import * as storageService from './storage.service.js';
import { emit as emitAudit } from './auditLog.service.js';

const ENCRYPTION_CONTEXT = Object.freeze({ purpose: 'email-outbox' });
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** Error codes that retrying cannot fix: dead-letter at once. */
const PERMANENT_CODES = new Set([
  'INVALID_INPUT',
  'TEMPLATE_UNKNOWN',
  'TEMPLATE_VARIABLES_MISSING',
  'TEMPLATE_VARIABLES_INVALID',
  'TEMPLATE_RENDER_FAILED',
  'RECIPIENT_REJECTED',
  'DECRYPTION_FAILED',
  'INVALID_ENVELOPE',
  'ATTACHMENT_MISSING',
]);
/** A due message older than this makes the outbox `degraded`. */
export const BACKLOG_DEGRADED_MS = 15 * 60 * 1000;
/** This many consecutive failed sends make the mail health `down`. */
export const CONSECUTIVE_FAILURES_DOWN = 3;
/** How long a transport verify result is reused by the health probe. */
const VERIFY_CACHE_MS = 60 * 1000;

let dispatchOnEnqueue = env.outbox.dispatchOnEnqueue;
const sendState = { lastSuccessAt: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0 };
let verifyState = null; // { ok, checkedAt, error }

/* ------------------------------- helpers -------------------------------- */

/** Exponential backoff for the attempt that just failed (1-based). */
export function computeBackoffMs(attempt, { baseMs = env.outbox.backoffBaseMs, maxMs = env.outbox.backoffMaxMs } = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}

/** Mask an address for operator views: `jo***@example.com`. */
export function maskEmail(address) {
  const value = String(address ?? '');
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${value.slice(at)}`;
}

function normaliseRecipients(to) {
  const list = (Array.isArray(to) ? to : [to])
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
  if (list.length === 0) {
    throw ApiError.badRequest('Email recipient is required', [{ field: 'to', message: 'At least one recipient is required' }]);
  }
  for (const address of list) {
    if (typeof address !== 'string' || address.length > 254 || !EMAIL_PATTERN.test(address)) {
      throw ApiError.badRequest('Invalid email recipient', [{ field: 'to', message: 'Each recipient must be a valid email address' }]);
    }
  }
  const unique = [...new Set(list)];
  if (unique.length > MAX_RECIPIENTS) {
    throw ApiError.badRequest('Too many recipients', [{ field: 'to', message: `At most ${MAX_RECIPIENTS} recipients per message` }]);
  }
  return unique;
}

function normaliseAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw ApiError.badRequest('attachments must be an array', [{ field: 'attachments', message: 'Must be an array' }]);
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw ApiError.badRequest('Too many attachments', [{ field: 'attachments', message: `At most ${MAX_ATTACHMENTS} attachments` }]);
  }
  return attachments.map((a, i) => {
    const filename = typeof a?.filename === 'string' ? a.filename.trim() : '';
    const storageKey = typeof a?.storageKey === 'string' ? a.storageKey.trim() : '';
    if (!filename || filename.length > 200 || /[\\/\r\n]/.test(filename) || !storageKey || storageKey.length > 512) {
      throw ApiError.badRequest('Invalid attachment', [{ field: `attachments[${i}]`, message: 'Needs a filename and a storageKey' }]);
    }
    const contentType = typeof a?.contentType === 'string' && a.contentType.length <= 120 ? a.contentType : 'application/octet-stream';
    return { filename, storageKey, contentType };
  });
}

function normaliseIdempotencyKey(key) {
  if (key === undefined || key === null || key === '') return `auto:${randomUUID()}`;
  if (typeof key !== 'string' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw ApiError.badRequest('Invalid idempotency key', [{ field: 'idempotencyKey', message: `A string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` }]);
  }
  return key;
}

/** Unique per tenant + caller key, so two tenants never collide. */
export function dedupeKeyFor(tenantId, idempotencyKey) {
  return createHash('sha256').update(`${tenantId ?? 'platform'}\n${idempotencyKey}`, 'utf8').digest('hex');
}

function messageIdFor(id) {
  const from = String(env.mail.from ?? '');
  const domain = (from.match(/@([^>\s]+)/)?.[1] ?? 'localhost').toLowerCase();
  return `<outbox.${String(id)}@${domain}>`;
}

function transportLabel() {
  if (emailService.isCapturing()) return 'capture';
  return emailService.getTransportType();
}

/** Hard cap on one variable value and on all variables together. */
const MAX_VARIABLE_LENGTH = 10000;
const MAX_VARIABLES_BYTES = 64 * 1024;

/**
 * Variables are stored (encrypted) and rendered later, so they must be
 * plain scalars of bounded size. Throws `{ message, field }` like the
 * template renderer does.
 */
function checkVariables(variables) {
  const fail = (message, field = null) => Object.assign(new Error(message), { field });
  if (variables === undefined || variables === null) return;
  if (typeof variables !== 'object' || Array.isArray(variables)) throw fail('variables must be an object');
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw fail(`variable name "${key}" is not allowed`, key);
    if (value === null || value === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw fail(`variable "${key}" must be a string, number or boolean`, key);
    }
    if (String(value).length > MAX_VARIABLE_LENGTH) throw fail(`variable "${key}" is too long`, key);
  }
  if (Buffer.byteLength(JSON.stringify(variables), 'utf8') > MAX_VARIABLES_BYTES) throw fail('variables are too large');
}

async function validateTemplate(template, variables) {
  if (typeof template !== 'string' || template.length === 0 || template.length > 64) {
    throw ApiError.badRequest('Email template is required', [{ field: 'template', message: 'A template key is required' }]);
  }
  try {
    checkVariables(variables);
    await emailService.renderTemplate(template, variables);
  } catch (err) {
    throw ApiError.badRequest(err?.message ?? 'Invalid email template input', [
      { field: err?.field ? `variables.${err.field}` : 'template', message: err?.message ?? 'Invalid' },
    ]);
  }
}

function toResult(row, extra = {}) {
  return { id: String(row._id), status: row.status, ...extra };
}

/* ------------------------------- enqueue -------------------------------- */

/**
 * Record a message in the outbox (validated, variables encrypted).
 *
 * @returns {Promise<{ row: Object, duplicate: boolean }>}
 */
async function record({ tenantId = null, to, template, variables = {}, idempotencyKey, attachments = [] } = {}) {
  const recipients = normaliseRecipients(to);
  const key = normaliseIdempotencyKey(idempotencyKey);
  const files = normaliseAttachments(attachments);
  const vars = variables ?? {};
  await validateTemplate(template, vars);
  const dedupeKey = dedupeKeyFor(tenantId, key);

  const existing = await outboxRepository.findByDedupeKey(dedupeKey);
  if (existing) return { row: existing, duplicate: true };

  try {
    const row = await outboxRepository.create({
      tenantId: tenantId === null || tenantId === undefined ? null : String(tenantId),
      to: recipients,
      template,
      variablesEnc: await encrypt(JSON.stringify(vars), ENCRYPTION_CONTEXT),
      attachments: files,
      idempotencyKey: key,
      dedupeKey,
      status: 'pending',
      attempts: 0,
      maxAttempts: env.outbox.maxAttempts,
      nextAttemptAt: clock.now(),
    });
    return { row, duplicate: false };
  } catch (err) {
    if (err?.code === 11000) {
      // A concurrent enqueue with the same key won the insert.
      const winner = await outboxRepository.findByDedupeKey(dedupeKey);
      if (winner) return { row: winner, duplicate: true };
    }
    throw err;
  }
}

/**
 * Enqueue a templated email for delivery by the outbox.
 *
 * @param {Object} params
 * @param {string|null} [params.tenantId=null]
 * @param {string|string[]} params.to
 * @param {string} params.template - template key from `src/templates/emails/index.js` (admin-editable, roadmap 2.4).
 * @param {Object} [params.variables={}] - flat scalar variables.
 * @param {string} [params.idempotencyKey] - same key, same message: never sent twice.
 * @param {Array<{ filename: string, storageKey: string, contentType?: string }>} [params.attachments=[]]
 * @returns {Promise<{ id: string, status: string, duplicate?: boolean }>}
 */
export async function enqueueEmail(params = {}) {
  const { row, duplicate } = await record(params);
  if (!duplicate && dispatchOnEnqueue) {
    // Best effort, off the caller's path; the email job retries what this misses.
    setImmediate(() => {
      dispatchById(String(row._id)).catch((err) => {
        logger.warn({ err: { message: err?.message }, outboxId: String(row._id) }, 'outbox dispatch-on-enqueue failed');
      });
    });
  }
  return toResult(row, duplicate ? { duplicate: true } : {});
}

/**
 * Record a message and make one delivery attempt now (interactive mail).
 * A failed attempt stays in the outbox and is retried by the email job.
 *
 * @param {Object} params - same as `enqueueEmail`.
 * @returns {Promise<{ id: string, status: string, delivered: boolean, accepted: string[], rejected: string[], error: { code: string, message: string } | null, duplicate?: boolean }>}
 */
export async function sendNow(params = {}) {
  const { row, duplicate } = await record(params);
  if (duplicate && row.status === 'sent') {
    return { ...toResult(row), delivered: true, accepted: [], rejected: [], error: null, duplicate: true };
  }
  const outcome = await dispatchById(String(row._id));
  if (!outcome) {
    // Someone else holds it (or it is not due yet): report its current state.
    const current = (await outboxRepository.findById(row._id)) ?? row;
    return { ...toResult(current), delivered: current.status === 'sent', accepted: [], rejected: [], error: current.lastError ?? null, ...(duplicate ? { duplicate: true } : {}) };
  }
  return { ...outcome, ...(duplicate ? { duplicate: true } : {}) };
}

/* ------------------------------- delivery ------------------------------- */

async function loadAttachments(attachments = []) {
  const out = [];
  for (const a of attachments) {
    let content;
    try {
      content = await storageService.get(a.storageKey);
    } catch {
      const err = new Error(`Attachment "${a.filename}" is no longer available`);
      err.code = 'ATTACHMENT_MISSING';
      throw err;
    }
    out.push({ filename: a.filename, contentType: a.contentType, content });
  }
  return out;
}

function noteSuccess(now) {
  sendState.lastSuccessAt = now;
  sendState.consecutiveFailures = 0;
}

function noteFailure(now, error) {
  sendState.lastFailureAt = now;
  sendState.lastError = error;
  sendState.consecutiveFailures += 1;
}

/**
 * Deliver a message this process has claimed, and record the outcome.
 *
 * @returns {Promise<{ id: string, status: 'sent'|'retrying'|'dead', delivered: boolean, accepted: string[], rejected: string[], error: Object|null }>}
 */
async function deliverClaimed(message, { now = clock.now(), sender = emailService.send } = {}) {
  const id = message._id;
  const lockToken = message.lockedBy ?? null;
  const result = (status, extra = {}) => ({ id: String(id), status, delivered: status === 'sent', accepted: [], rejected: [], error: null, ...extra });

  if (message.attempts > message.maxAttempts) {
    const error = { code: 'ATTEMPTS_EXHAUSTED', message: 'Delivery attempts exhausted' };
    await outboxRepository.markDead(id, { now, error, lockToken });
    return result('dead', { error });
  }

  let envelope;
  try {
    const variables = message.variablesEnc ? JSON.parse(await decrypt(message.variablesEnc, ENCRYPTION_CONTEXT)) : {};
    const rendered = await emailService.renderTemplate(message.template, variables);
    envelope = {
      to: message.to,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html ? { html: rendered.html } : {}),
      messageId: messageIdFor(id),
      attachments: await loadAttachments(message.attachments ?? []),
    };
  } catch (err) {
    const error = sanitizeError(err, { fallbackCode: 'RENDER_FAILED' });
    await outboxRepository.markDead(id, { now, error, lockToken });
    logger.error({ outboxId: String(id), template: message.template, code: error.code }, 'outbox message dead-lettered: cannot be rendered');
    return result('dead', { error });
  }

  try {
    const info = await sender(envelope);
    const accepted = (info?.accepted ?? []).map(String);
    const rejected = (info?.rejected ?? []).map(String);
    if (rejected.length > 0 && accepted.length === 0) {
      const err = new Error('Every recipient was rejected by the mail server');
      err.code = 'RECIPIENT_REJECTED';
      throw err;
    }
    await outboxRepository.markSent(id, { now, messageId: info?.messageId ?? envelope.messageId, transport: transportLabel(), lockToken });
    noteSuccess(now);
    return result('sent', { accepted, rejected });
  } catch (err) {
    const error = sanitizeError(err, { fallbackCode: 'SEND_FAILED' });
    // EmailError('SEND_FAILED') wraps the transport error; validation errors
    // and rejected recipients will not get better on retry.
    const permanent = PERMANENT_CODES.has(error.code);
    noteFailure(now, error);
    if (permanent || message.attempts >= message.maxAttempts) {
      await outboxRepository.markDead(id, { now, error, lockToken });
      logger.error({ outboxId: String(id), attempts: message.attempts, code: error.code }, 'outbox message dead-lettered');
      return result('dead', { error });
    }
    const nextAttemptAt = new Date(now.getTime() + computeBackoffMs(message.attempts));
    await outboxRepository.markRetry(id, { nextAttemptAt, error, lockToken });
    logger.warn({ outboxId: String(id), attempts: message.attempts, nextAttemptAt, code: error.code }, 'outbox send failed; will retry');
    return result('retrying', { error, nextAttemptAt });
  }
}

/**
 * Claim and deliver one specific message if it is due.
 *
 * @param {string} id
 * @param {Object} [options]
 * @returns {Promise<Object|null>} the outcome, or null when it could not be claimed.
 */
export async function dispatchById(id, { now = clock.now(), owner = getInstanceId(), sender } = {}) {
  const claimed = await outboxRepository.claimNext({ now, owner, leaseMs: env.outbox.leaseMs, id });
  if (!claimed) return null;
  return deliverClaimed(claimed, { now, ...(sender ? { sender } : {}) });
}

/**
 * Drain due messages (the email job). Each message is claimed atomically,
 * so overlapping drains share the backlog without double-sending.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.limit=OUTBOX_BATCH_SIZE]
 * @param {string} [options.owner]
 * @param {Function} [options.sender] - tests inject a transport double.
 * @returns {Promise<{ claimed: number, sent: number, retried: number, deadLettered: number }>}
 */
export async function drainOutbox({ now = clock.now(), limit = env.outbox.batchSize, owner = getInstanceId(), sender } = {}) {
  const counts = { claimed: 0, sent: 0, retried: 0, deadLettered: 0 };
  const max = Math.max(1, Number(limit) || 1);
  for (let i = 0; i < max; i += 1) {
    const claimed = await outboxRepository.claimNext({ now, owner, leaseMs: env.outbox.leaseMs });
    if (!claimed) break;
    counts.claimed += 1;
    const outcome = await deliverClaimed(claimed, { now, ...(sender ? { sender } : {}) });
    if (outcome.status === 'sent') counts.sent += 1;
    else if (outcome.status === 'retrying') counts.retried += 1;
    else if (outcome.status === 'dead') counts.deadLettered += 1;
  }
  return counts;
}

/* ------------------------------ operations ------------------------------ */

function toView(row) {
  return {
    id: String(row._id),
    tenantId: row.tenantId ?? null,
    to: (row.to ?? []).map(maskEmail),
    template: row.template,
    status: row.status,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? null,
    nextAttemptAt: row.nextAttemptAt ?? null,
    lastAttemptAt: row.lastAttemptAt ?? null,
    sentAt: row.sentAt ?? null,
    deadAt: row.deadAt ?? null,
    lastError: row.lastError ?? null,
    transport: row.transport ?? null,
    createdAt: row.createdAt ?? null,
  };
}

/**
 * Paginated outbox listing for platform monitoring (recipients masked,
 * variables never returned). A tenant-scoped admin (`scopeTenantId`) only
 * ever sees that tenant's messages, whatever `tenantId` asks for.
 */
export async function listMessages({ status, tenantId, scopeTenantId = null, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status !== undefined && status !== null && status !== '') {
    if (!OUTBOX_STATUSES.includes(String(status))) {
      throw ApiError.badRequest('Invalid status filter', [{ field: 'status', message: `One of ${OUTBOX_STATUSES.join(', ')}` }]);
    }
    filter.status = String(status);
  }
  if (typeof tenantId === 'string' && tenantId.trim()) filter.tenantId = tenantId.trim().slice(0, 64);
  if (scopeTenantId) filter.tenantId = String(scopeTenantId);
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const result = await outboxRepository.list({ filter, page: p, limit: l });
  return { ...result, docs: result.docs.map(toView) };
}

/**
 * Return a dead-lettered message to the queue with a fresh attempt budget.
 *
 * @param {Object} params
 * @param {string} params.id
 * @param {{ type: string, id: string|null }} [params.actor]
 * @param {string|null} [params.scopeTenantId] - tenant-scoped admins only
 *   reach their own tenant's messages.
 */
export async function requeueDeadMessage({ id, actor = null, scopeTenantId = null } = {}) {
  const existing = await outboxRepository.findById(id);
  if (!existing || (scopeTenantId && String(existing.tenantId) !== String(scopeTenantId))) {
    throw ApiError.notFound('Outbox message not found');
  }
  if (existing.status !== 'dead') throw ApiError.conflict('Only dead-lettered messages can be requeued');
  const row = await outboxRepository.requeueDead(existing._id, { now: clock.now() });
  if (!row) throw ApiError.conflict('Only dead-lettered messages can be requeued');
  try {
    await emitAudit({
      actor: actor ?? { type: 'system', id: null },
      action: 'outbox.requeue',
      module: 'monitoring',
      resource: { type: 'outboundEmail', id: String(row._id) },
      tenantId: row.tenantId ?? null,
      after: { template: row.template, status: row.status },
    });
  } catch {
    /* best-effort audit */
  }
  return toView(row);
}

async function verifyTransport(now) {
  if (verifyState && now.getTime() - verifyState.checkedAt.getTime() < VERIFY_CACHE_MS) return verifyState;
  try {
    await emailService.verify();
    verifyState = { ok: true, checkedAt: now, error: null };
  } catch (err) {
    verifyState = { ok: false, checkedAt: now, error: sanitizeError(err, { fallbackCode: 'VERIFY_FAILED' }) };
  }
  return verifyState;
}

/**
 * Mail + outbox health (monitoring probe). With `probe: true` and an SMTP
 * transport, verifies the connection (bounded by SMTP_VERIFY_TIMEOUT_MS,
 * cached for a minute).
 *
 * status: `disabled` (no transport configured: mail is not delivered),
 * `down` (verify failed or repeated send failures), `degraded` (dead
 * letters or a backlog older than 15 minutes), `ok`.
 */
export async function getOutboxHealth({ now = clock.now(), probe = false } = {}) {
  const transport = transportLabel();
  const [counts, oldest, last] = await Promise.all([
    outboxRepository.countByStatus(),
    outboxRepository.oldestDue(now),
    outboxRepository.lastSent(),
  ]);
  const verify = probe && transport === 'smtp' ? await verifyTransport(now) : verifyState;
  const backlogAgeMs = oldest ? Math.max(0, now.getTime() - new Date(oldest.nextAttemptAt).getTime()) : 0;

  let status = 'ok';
  if (transport === 'noop') status = 'disabled';
  else if ((verify && verify.ok === false) || sendState.consecutiveFailures >= CONSECUTIVE_FAILURES_DOWN) status = 'down';
  else if (counts.dead > 0 || backlogAgeMs > BACKLOG_DEGRADED_MS) status = 'degraded';

  return {
    status,
    transport,
    checkedAt: now.toISOString(),
    verify: verify ? { ok: verify.ok, checkedAt: verify.checkedAt.toISOString(), error: verify.error } : null,
    sends: {
      lastSuccessAt: sendState.lastSuccessAt ? sendState.lastSuccessAt.toISOString() : null,
      lastFailureAt: sendState.lastFailureAt ? sendState.lastFailureAt.toISOString() : null,
      lastError: sendState.lastError,
      consecutiveFailures: sendState.consecutiveFailures,
    },
    outbox: {
      ...counts,
      backlog: counts.pending + counts.retrying,
      oldestDueAt: oldest ? new Date(oldest.nextAttemptAt).toISOString() : null,
      backlogAgeMs,
      lastSentAt: last?.sentAt ? new Date(last.sentAt).toISOString() : null,
    },
    settings: {
      maxAttempts: env.outbox.maxAttempts,
      backoffBaseMs: env.outbox.backoffBaseMs,
      backoffMaxMs: env.outbox.backoffMaxMs,
    },
  };
}

/* -------------------------------- tests --------------------------------- */

/** Test hook: turn the dispatch-on-enqueue nudge on or off. */
export function setDispatchOnEnqueue(value) {
  dispatchOnEnqueue = Boolean(value);
}

/** Test hook: forget in-memory send/verify state. */
export function resetOutboxStateForTests() {
  sendState.lastSuccessAt = null;
  sendState.lastFailureAt = null;
  sendState.lastError = null;
  sendState.consecutiveFailures = 0;
  verifyState = null;
  dispatchOnEnqueue = env.outbox.dispatchOnEnqueue;
}

export default {
  enqueueEmail,
  sendNow,
  dispatchById,
  drainOutbox,
  listMessages,
  requeueDeadMessage,
  getOutboxHealth,
  computeBackoffMs,
  maskEmail,
  dedupeKeyFor,
  setDispatchOnEnqueue,
  resetOutboxStateForTests,
};
