/**
 * auditConsumer.service.js (Sprint 8 - implemented; roadmap 2.5 - deletes,
 * bulk updates, allow-list payloads).
 *
 * PURPOSE
 *   Wires the `audit` Mongoose plugin to the audit trail. The plugin emits
 *   lightweight domain events on every model it is applied to; this service
 *   subscribes to those emitters and persists a structured `AuditLog` row
 *   per change:
 *     - create / update / softDelete / restore  (document changes)
 *     - delete      (single hard delete, with what was deleted)
 *     - update      (`updateOne` without a document: filter + counts)
 *     - updateMany  (filter, update and matched/modified counts)
 *     - deleteMany  (filter and deleted count)
 *     - createMany  (`insertMany`: inserted count and the first ids)
 *
 * PAYLOADS (allow-list)
 *   `before` / `after` only ever contain the fields listed for the model in
 *   `models/plugins/auditPolicy.js`; for updates only the allow-listed fields
 *   that actually changed. `metadata.changedFields` names every business
 *   field that changed (including ones whose values are not kept, e.g.
 *   `passwordHash`), so "the password was changed" is visible without the
 *   hash. Filters and updates of bulk writes are stored as JSON text with
 *   non-allow-listed values replaced by `[REDACTED]`. Dates and ObjectIds are
 *   stored as ISO / hex strings (`utils/auditPayload.js`).
 *
 * NOISE CONTROL
 *   Writes that only touch bookkeeping fields (policy `ignore`) and models
 *   whose policy is `off` write no rows; an update with no business change
 *   writes no row; bulk writes that modified nothing write no row.
 *
 * MODEL-LEVEL vs REQUEST-LEVEL ROWS
 *   Service-level emits record *domain* events (`dashboard.published`,
 *   `support.impersonate`, ...) and security events
 *   (`services/securityEvent.service.js`). This consumer records *row-level*
 *   changes. The layers are complementary, not duplicates.
 *
 * ACTOR AND CONTEXT
 *   The actor rides the async context populated by the auth middleware
 *   (`utils/actorContext.js`); outside a request (queue workers, scheduler,
 *   seeds) the row is attributed to `system`. The request id, ip and user
 *   agent come from the same context.
 *
 * SAFETY
 *   - A consumer failure is logged and swallowed: audit must never break the
 *     business operation that produced the event.
 *   - The consumer never writes `AuditLog` directly; it goes through
 *     `auditLog.service.emit` so serialisation, redaction and the hash chain
 *     apply.
 */

import mongoose from 'mongoose';
import { auditRegistry } from '../models/plugins/audit.js';
import { getAuditPolicy, recordsEvent, pathMatches, META_PATHS } from '../models/plugins/auditPolicy.js';
import * as auditLogService from './auditLog.service.js';
import { getCurrentRequestId } from '../utils/actorContext.js';
import { REDACTED, canonicalJson, getPath, setPath, projectFields, toAuditValue } from '../utils/auditPayload.js';
import logger from '../utils/logger.js';

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);

/** Soft-delete bookkeeping: recorded by the dedicated softDelete/restore rows. */
const LIFECYCLE_KEYS = new Set(['deletedAt', 'deletedBy']);

/** Longest filter/update description kept in `metadata`. */
const MAX_QUERY_TEXT = 2000;

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

/** Plain-object state of a hydrated or lean document. */
function plain(doc) {
  if (!doc) return null;
  return typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : doc;
}

/** Allow-listed view of a snapshot, with conditional secrets redacted. */
function allowed(policy, snapshot) {
  const projected = projectFields(snapshot, policy.fields);
  if (!projected) return null;
  const secret = policy.secretWhen;
  if (secret && snapshot?.[secret.flag] === true) {
    for (const field of secret.fields) {
      if (getPath(projected, field) !== undefined) setPath(projected, field, REDACTED);
    }
  }
  return projected;
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * Business diff between two snapshots, limited to the policy.
 *
 * @returns {{ before: Object, after: Object, changedFields: string[] } | null}
 *   null when nothing but bookkeeping changed.
 */
function diff(policy, before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed = [];
  for (const key of keys) {
    if (key.startsWith('$') || pathMatches(META_PATHS, key) || LIFECYCLE_KEYS.has(key)) continue;
    if (pathMatches(policy.ignore, key)) continue;
    if (!same(before?.[key], after?.[key])) changed.push(key);
  }
  if (changed.length === 0) return null;

  const b = {};
  const a = {};
  for (const field of policy.fields) {
    const top = field.split('.')[0];
    if (!changed.includes(top)) continue;
    const bv = getPath(before, field);
    const av = getPath(after, field);
    if (same(bv, av)) continue;
    if (bv !== undefined) setPath(b, field, bv);
    if (av !== undefined) setPath(a, field, av);
  }
  const secret = policy.secretWhen;
  if (secret && (before?.[secret.flag] === true || after?.[secret.flag] === true)) {
    for (const field of secret.fields) {
      if (getPath(b, field) !== undefined) setPath(b, field, REDACTED);
      if (getPath(a, field) !== undefined) setPath(a, field, REDACTED);
    }
  }
  return { before: b, after: a, changedFields: changed.sort() };
}

/**
 * Describe a filter or update document for the trail: operators kept,
 * values of fields outside the allow-list replaced with `[REDACTED]`,
 * serialised as canonical JSON text (Mongo operators cannot be stored as
 * keys).
 */
function describeQuery(policy, value) {
  const keep = (field) => field === '_id' || field === 'tenantId' || pathMatches(policy.fields, field);
  const walk = (node, field) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, field));
    if (node && typeof node === 'object' && !(node instanceof Date) && !(node instanceof RegExp)
      && node._bsontype === undefined) {
      const out = {};
      for (const [key, inner] of Object.entries(node)) {
        if (key.startsWith('$')) out[key] = walk(inner, field);
        else out[key] = walk(inner, field ? `${field}.${key}` : key);
      }
      return out;
    }
    if (field && !keep(field)) return REDACTED;
    return node;
  };
  const text = canonicalJson(walk(value ?? null, null));
  return text.length > MAX_QUERY_TEXT ? `${text.slice(0, MAX_QUERY_TEXT)}…` : text;
}

/** A scalar id from a filter (`{ _id: x }` / `{ tenantId: x }`), else null. */
function scalarFrom(filter, key) {
  const value = filter?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value._bsontype === 'ObjectId' || value._bsontype === 'ObjectID') return value.toHexString();
  return null;
}

/** Build the row for one plugin event, or null when nothing should be stored. */
function buildRow(eventName, payload, policy) {
  const { doc, modelName } = payload;
  const resourceType = String(modelName ?? doc?.constructor?.modelName ?? 'document').toLowerCase();

  if (eventName === 'bulkCreate') {
    const result = payload.result ?? {};
    return {
      action: 'createMany',
      resource: { type: resourceType, id: null },
      tenantId: payload.tenantId ?? null,
      before: null,
      after: null,
      metadata: {
        operation: payload.operation ?? 'insertMany',
        insertedCount: result.insertedCount ?? 0,
        ids: Array.isArray(result.ids) ? result.ids : [],
      },
    };
  }

  if (eventName === 'bulkUpdate' || eventName === 'bulkDelete') {
    const result = payload.result ?? {};
    const isSingle = payload.operation === 'updateOne' || payload.operation === 'replaceOne'
      || payload.operation === 'deleteOne';
    let action;
    if (eventName === 'bulkDelete') action = isSingle ? 'delete' : 'deleteMany';
    else action = isSingle ? 'update' : 'updateMany';
    const metadata = {
      operation: payload.operation,
      filter: describeQuery(policy, payload.filter),
      ...(eventName === 'bulkUpdate'
        ? {
            update: describeQuery(policy, payload.update),
            matchedCount: result.matchedCount ?? 0,
            modifiedCount: result.modifiedCount ?? 0,
            upsertedCount: result.upsertedCount ?? 0,
          }
        : { deletedCount: result.deletedCount ?? 0 }),
    };
    return {
      action,
      resource: { type: resourceType, id: scalarFrom(payload.filter, '_id') },
      tenantId: scalarFrom(payload.filter, 'tenantId'),
      before: null,
      after: null,
      metadata,
    };
  }

  if (!doc || doc._id == null) return null;
  const tenantId = doc.tenantId != null ? String(doc.tenantId) : null;
  const resource = { type: resourceType, id: String(doc._id) };

  if (eventName === 'update') {
    // Query updates carry the prior state read by the plugin; saves diff
    // against the snapshot taken when the document was loaded.
    const fromQuery = Boolean(payload.operation);
    const beforeState = fromQuery ? payload.before : doc.$__initialState;
    const afterState = plain(doc);
    // Advance the snapshot so consecutive saves diff incrementally.
    if (!fromQuery && typeof doc.toObject === 'function') {
      doc.$__initialState = doc.toObject({ depopulate: true });
    }
    if (!beforeState) {
      // Prior state unknown (read failed): record the allow-listed result.
      return {
        action: 'update', resource, tenantId, before: null, after: allowed(policy, afterState),
        metadata: { operation: payload.operation ?? 'save', priorStateUnavailable: true },
      };
    }
    const changes = diff(policy, plain(beforeState), afterState);
    if (!changes) return null;
    return {
      action: 'update',
      resource,
      tenantId,
      before: changes.before,
      after: changes.after,
      metadata: { operation: payload.operation ?? 'save', changedFields: changes.changedFields },
    };
  }

  const snapshot = plain(doc);
  if (eventName === 'create') {
    return { action: 'create', resource, tenantId, before: null, after: allowed(policy, snapshot), metadata: null };
  }
  if (eventName === 'softDelete') {
    return { action: 'softDelete', resource, tenantId, before: allowed(policy, snapshot), after: null, metadata: null };
  }
  if (eventName === 'restore') {
    return { action: 'restore', resource, tenantId, before: null, after: allowed(policy, snapshot), metadata: null };
  }
  if (eventName === 'delete') {
    return {
      action: 'delete',
      resource,
      tenantId,
      before: allowed(policy, snapshot),
      after: null,
      metadata: { operation: payload.operation ?? 'deleteOne' },
    };
  }
  return null;
}

/**
 * Persist one plugin event as an AuditLog row. Never throws into the caller.
 */
async function persist(eventName, payload = {}) {
  if (payload.auditSkip) return;
  const modelName = payload.modelName ?? payload.doc?.constructor?.modelName;
  const policy = getAuditPolicy(modelName);
  if (!recordsEvent(policy, eventName)) return;

  let row;
  try {
    row = buildRow(eventName, { ...payload, modelName }, policy);
  } catch (err) {
    logger.error({ err: { message: err.message }, module: payload.module, event: eventName }, '[audit-consumer] build failed');
    return;
  }
  if (!row) return;

  try {
    await auditLogService.emit({
      actor: resolveActor(payload.actor),
      action: row.action,
      module: payload.module,
      resource: row.resource,
      before: row.before,
      after: row.after,
      metadata: row.metadata ? toAuditValue(row.metadata) : null,
      tenantId: row.tenantId,
      requestId: getCurrentRequestId() ?? null,
    });
  } catch (err) {
    logger.error({ err: { message: err.message }, module: payload.module, event: eventName }, '[audit-consumer] persist failed');
  }
}

const EVENTS = ['create', 'update', 'softDelete', 'restore', 'delete', 'bulkUpdate', 'bulkDelete', 'bulkCreate'];

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
    for (const name of EVENTS) emitter.on(name, (payload) => persist(name, payload));
  }
}

export default { initAuditConsumer, _internals: { diff, describeQuery, allowed } };
