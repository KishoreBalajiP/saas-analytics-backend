/**
 * auditConsumer.service.js (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Wires the `audit` Mongoose plugin to the audit trail. The plugin emits
 *   lightweight domain events (`create` / `update` / `softDelete` /
 *   `restore`) on every model it is applied to; this service subscribes to
 *   those emitters and persists a structured `AuditLog` row per change.
 *
 * WHY A CONSUMER
 *   The trail has a single write entry point (`auditLog.service.emit`) that
 *   validates shape and redacts sensitive payloads. The plugin never imports
 *   the service (that would be an import cycle through the model barrel), so
 *   this module is the bridge: subscribe here, persist there.
 *
 * MODEL-LEVEL vs REQUEST-LEVEL ROWS
 *   Service-level emits record *domain* events (`dashboard.published`,
 *   `support.impersonate`, ...) with a reason and request context. This
 *   consumer records *row-level* changes (module + `create`/`update`/
 *   `softDelete`/`restore` + a before/after diff). The two are complementary
 *   layers of the trail, not duplicates.
 *
 * ACTOR
 *   The actor rides the async context populated by the auth middleware
 *   (`utils/actorContext.js`). Outside a request (queue workers, scheduler,
 *   seeds) the row is attributed to `system`.
 *
 * SAFETY
 *   - A consumer failure is logged and swallowed: audit must never break the
 *     business operation that produced the event.
 *   - The consumer never writes `AuditLog` directly; it goes through
 *     `auditLog.service.emit` so redaction + append-only rules apply.
 */

import mongoose from 'mongoose';
import { auditRegistry } from '../models/plugins/audit.js';
import * as auditLogService from './auditLog.service.js';
import { getCurrentRequestId } from '../utils/actorContext.js';
import logger from '../utils/logger.js';

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);

/** Keys stripped from persisted before/after payloads (meta, not business data). */
const META_KEYS = new Set(['_id', '__v', '$__initialState', '$__auditWasNew']);

/** Bookkeeping fields - a change limited to these is not a business change. */
const LIFECYCLE_KEYS = new Set(['deletedAt', 'deletedBy', 'createdAt', 'updatedAt']);

/** Emitters already wired, so `initAuditConsumer()` is idempotent. */
const subscribed = new WeakSet();

/**
 * Normalise the actor the plugin resolved. Falls back to `system` - never
 * invents an identity.
 */
function resolveActor(actor) {
  if (actor && ACTOR_TYPES.has(actor.type)) {
    return { type: actor.type, id: actor.id ?? null, display: actor.email ?? actor.display ?? null };
  }
  if (actor && actor.id) {
    return { type: 'system', id: String(actor.id), display: null };
  }
  return { type: 'system', id: null, display: null };
}

/** Strip `_id` / `__v` / internal snapshot keys from a plain object. */
function clean(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (META_KEYS.has(key) || key.startsWith('$')) continue;
    out[key] = value;
  }
  return out;
}

/** Current state of a doc as a cleaned plain object. */
function snapshot(doc) {
  const obj = doc.toObject ? doc.toObject({ depopulate: true }) : doc;
  return clean(obj);
}

/** True when business fields actually changed (ignores soft-delete bookkeeping). */
function businessChanged(before, after) {
  if (!before || !after) return true;
  const diff = (side, key) => (LIFECYCLE_KEYS.has(key) ? null : side[key]);
  const b = {};
  const a = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (LIFECYCLE_KEYS.has(key)) continue;
    b[key] = before[key];
    a[key] = after[key];
  }
  return JSON.stringify(b) !== JSON.stringify(a);
}

/**
 * Persist one plugin event as an AuditLog row. Never throws into the caller.
 */
async function persist(eventName, { module, doc, actor, modelName } = {}) {
  if (!doc || doc._id == null) return;

  const resourceType = (doc.constructor?.modelName ?? modelName ?? 'document').toLowerCase();
  const tenantId = doc.tenantId != null ? String(doc.tenantId) : null;

  let before = null;
  let after = null;
  if (eventName === 'update') {
    before = doc.$__initialState ? clean(doc.$__initialState) : null;
    after = snapshot(doc);
    // A save that only flipped soft-delete bookkeeping (softDelete()/restore())
    // is already recorded as its own event - skip the redundant update row.
    if (!businessChanged(before, after)) return;
    // Advance the snapshot so consecutive updates diff incrementally. Lean
    // docs from `findOneAndUpdate` have no toObject and no initial state.
    if (doc.toObject) doc.$__initialState = doc.toObject({ depopulate: true });
  } else if (eventName === 'create') {
    after = snapshot(doc);
  } else if (eventName === 'softDelete') {
    before = snapshot(doc);
  } else if (eventName === 'restore') {
    after = snapshot(doc);
  }

  try {
    await auditLogService.emit({
      actor: resolveActor(actor),
      action: eventName,
      module,
      resource: { type: resourceType, id: String(doc._id) },
      before,
      after,
      tenantId,
      requestId: getCurrentRequestId() ?? null,
    });
  } catch (err) {
    logger.error({ err: { message: err.message }, module, event: eventName }, '[audit-consumer] persist failed');
  }
}

/**
 * Wire every audit-enabled model to the trail. Idempotent: emitters already
 * subscribed are skipped, and late-registered models are picked up on the
 * next call. Called from the server bootstrap and the test harness.
 */
export function initAuditConsumer() {
  const sources = [];

  // Plugin-applied models registered at schema definition time.
  for (const entry of auditRegistry) sources.push(entry.emitter);
  // Models compiled before `initAuditConsumer()` (e.g. in tests) that carry
  // the plugin's `events` static but are not yet in the registry.
  for (const model of Object.values(mongoose.models)) {
    if (model.events) sources.push(model.events);
  }

  for (const emitter of sources) {
    if (subscribed.has(emitter)) continue;
    subscribed.add(emitter);

    emitter.on('create', (payload) => persist('create', payload));
    emitter.on('update', (payload) => persist('update', payload));
    emitter.on('softDelete', (payload) => persist('softDelete', payload));
    emitter.on('restore', (payload) => persist('restore', payload));
  }
}

export default { initAuditConsumer };
