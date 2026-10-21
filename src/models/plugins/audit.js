/**
 * Mongoose plugin: audit.
 *
 * WHY IT EXISTS
 *   Governance needs to know who changed what and when. This plugin emits
 *   lightweight domain events for every write path on the model;
 *   `services/auditConsumer.service.js` subscribes (via `auditRegistry`
 *   below) and persists them to `AuditLog` through
 *   `services/auditLog.service.js`. What is kept per model (allow-listed
 *   fields, bookkeeping fields, models that write no rows) is decided in
 *   `models/plugins/auditPolicy.js`.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(audit, { module: 'iam.users' });
 *   ```
 *
 * EVENTS (`Model.events.on(name, payload => ...)`)
 *   - `create`     after a document is saved for the first time (or a
 *                  `findOneAndUpdate` upsert created one).
 *   - `update`     after `save()` of an existing document, or after
 *                  `findOneAndUpdate` / `findOneAndReplace`. Query updates
 *                  carry `before`: the prior state, read in a `pre` hook
 *                  (hydrated results cannot be diffed against themselves).
 *                  When the query returns the original document (Mongoose's
 *                  default `new: false`), the written state is read back.
 *   - `softDelete` when `softDelete()` removes the document.
 *   - `restore`    when `restore()` brings a document back.
 *   - `delete`     after a single hard delete: `findOneAndDelete` /
 *                  `findByIdAndDelete`, query `deleteOne` (the prior state is
 *                  read first) and `doc.deleteOne()`.
 *   - `bulkUpdate` after `updateOne` / `updateMany` / `replaceOne`, with the
 *                  filter, the update and the matched/modified counts.
 *   - `bulkDelete` after `deleteMany`, with the filter and deleted count.
 *   - `bulkCreate` after `insertMany` (which skips the save hooks), with the
 *                  inserted count and the first ids.
 *
 *   Payload: `{ module, modelName, doc?, before?, filter?, update?,
 *   operation?, result?, actor, auditSkip? }`. `auditSkip: true` marks a
 *   write the trail ignores (policy `off`, or only bookkeeping fields
 *   touched); the event is still emitted so other listeners (the auth
 *   status cache) see every change.
 *
 * ACTOR
 *   The actor is resolved from `utils/actorContext.js` (AsyncLocalStorage
 *   populated by the auth middleware), falling back to the optional
 *   `Actor` model's `current` static, then `null` (the consumer records
 *   `system`). Never a fabricated identity.
 *
 * COST
 *   Query updates and single deletes read the prior state once (lean, same
 *   filter, same session). The read is skipped for models whose policy is
 *   `off` and for updates that only touch bookkeeping fields (`ignore`), so
 *   hot paths (token refresh, failed-login counters, API key `lastUsedAt`,
 *   usage counters) cost nothing extra.
 *
 * HOW TO EXTEND
 *   - Apply the plugin to a model with a `module` tag AND add the model to
 *     `auditPolicy.js`; the model is registered in `auditRegistry` and
 *     consumed on the next `initAuditConsumer()` call.
 */

import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { getCurrentActor } from '../../utils/actorContext.js';
import { getAuditPolicy, recordsEvent, touchesOnlyIgnored } from './auditPolicy.js';

const DEFAULT_OPTIONS = Object.freeze({
  /** Logical module name, used by the audit consumer to tag the entry. */
  module: 'unknown',
});

/**
 * Models the audit plugin has been applied to. The consumer subscribes to
 * each `emitter` so model changes persist to the trail. Kept here (not in
 * the consumer) to avoid an import cycle with `services/auditLog.service.js`.
 *
 * @type {Array<{ emitter: EventEmitter, module: string }>}
 */
export const auditRegistry = [];

/** Query options worth carrying into the prior-state read. */
function readOptions(query, { includeDeleted = false } = {}) {
  const options = query.getOptions ? query.getOptions() : {};
  const out = {};
  if (options.session) out.session = options.session;
  if (options.sort) out.sort = options.sort;
  if (includeDeleted || options.includeDeleted === true) out.includeDeleted = true;
  return out;
}

/** Unwrap `findOneAndUpdate(..., { includeResultMetadata: true })` results. */
function unwrapResult(res) {
  if (res && typeof res === 'object' && 'lastErrorObject' in res && 'value' in res) return res.value;
  return res;
}

/**
 * True when a findOneAndUpdate/findOneAndReplace hands back the document as
 * it was BEFORE the write (Mongoose's default `new: false`,
 * `returnDocument: 'before'`, `returnOriginal: true`).
 */
function returnsOriginal(query) {
  const options = query.getOptions ? query.getOptions() : {};
  if (options.returnDocument !== undefined) return options.returnDocument !== 'after';
  if (options.new !== undefined) return options.new !== true;
  if (options.returnOriginal !== undefined) return options.returnOriginal !== false;
  return true;
}

/**
 * Attach the audit plugin to a schema.
 *
 * @param {import('mongoose').Schema} schema
 * @param {Object} [options]
 */
export function audit(schema, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const emitter = new EventEmitter();
  schema.statics.events = emitter;
  auditRegistry.push({ emitter, module: opts.module });

  /**
   * Resolve the actor for the current operation. Reads the async actor
   * context (populated by the auth middleware), then the optional
   * `Actor` model's `current` static. Defaults to `null`; the consumer
   * records `system` when no actor is present.
   */
  function resolveActor() {
    return getCurrentActor() ?? mongoose?.models?.Actor?.current ?? null;
  }

  function emit(event, payload) {
    emitter.emit(event, { module: opts.module, actor: resolveActor(), ...payload });
  }

  /** Should a query write skip the trail (and the prior-state read)? */
  function skipQuery(query, eventName, update) {
    const policy = getAuditPolicy(query.model?.modelName);
    if (!recordsEvent(policy, eventName)) return true;
    return update !== undefined && touchesOnlyIgnored(policy, update);
  }

  async function readPrior(query, { includeDeleted = false } = {}) {
    try {
      return await query.model
        .findOne({ ...query.getFilter() })
        .setOptions(readOptions(query, { includeDeleted }))
        .lean();
    } catch {
      // The write itself will surface any real error; auditing never blocks it.
      return null;
    }
  }

  /* ----------------------------- document saves ----------------------------- */

  // Capture `isNew` before save so we can distinguish create from update
  // in the post-save hook (Mongoose flips `isNew` to false during save).
  schema.pre('save', function (next) {
    this.$__auditWasNew = this.isNew;
    next();
  });

  schema.post('save', function (doc) {
    const event = doc.$__auditWasNew ? 'create' : 'update';
    delete doc.$__auditWasNew;
    // Seed the diff baseline for docs that were created in-memory (never
    // hydrated), so a later save (e.g. softDelete) can be diffed properly.
    if (event === 'create' && typeof doc.toObject === 'function') {
      doc.$__initialState = doc.toObject({ depopulate: true });
    }
    emit(event, { doc, modelName: doc.constructor?.modelName });
  });

  schema.post('init', function (doc) {
    // capture initial state so we can diff in the update handler.
    doc.$__initialState = doc.toObject();
  });

  /* ------------------------- single-document queries ------------------------ */

  for (const op of ['findOneAndUpdate', 'findOneAndReplace']) {
    schema.pre(op, async function captureBefore() {
      const update = op === 'findOneAndUpdate' ? this.getUpdate() : undefined;
      this.$__auditSkip = skipQuery(this, 'update', update);
      if (this.$__auditSkip) return;
      this.$__auditBefore = await readPrior(this);
      this.$__auditBeforeRead = true;
    });

    schema.post(op, async function emitUpdate(res) {
      let doc = unwrapResult(res);
      const modelName = this.model?.modelName;
      const skipped = this.$__auditSkip === true;
      // The result is the PRE-update document (Mongoose's default
      // `new: false`): diffing it against the prior state would show no
      // change, so read what the write produced. An upsert that inserted
      // returns null here.
      if (!skipped && returnsOriginal(this)) {
        const id = doc?._id ?? this.$__auditBefore?._id ?? null;
        if (id != null) {
          doc = await this.model.findOne({ _id: id })
            .setOptions(readOptions(this, { includeDeleted: true }))
            .lean()
            .catch(() => null);
        } else if (!doc && this.$__auditBeforeRead === true && this.getOptions?.().upsert === true) {
          doc = await this.model.findOne({ ...this.getFilter() })
            .setOptions(readOptions(this, { includeDeleted: true }))
            .lean()
            .catch(() => null);
        }
      }
      if (!doc) return;
      // A prior read that found nothing means an upsert created the doc.
      const created = this.$__auditBeforeRead === true && !this.$__auditBefore;
      emit(created ? 'create' : 'update', {
        doc,
        // `lean: true` returns a plain object, so the consumer cannot read
        // `doc.constructor.modelName` - hand it over.
        modelName,
        before: this.$__auditBefore ?? null,
        operation: op,
        auditSkip: skipped,
      });
    });
  }

  schema.post('findOneAndDelete', function emitDelete(res) {
    const doc = unwrapResult(res);
    if (!doc) return;
    emit('delete', {
      doc,
      modelName: this.model?.modelName,
      operation: 'findOneAndDelete',
      auditSkip: skipQuery(this, 'delete'),
    });
  });

  // `Model.deleteOne(filter)` and `doc.deleteOne()` (Mongoose runs the
  // document form through these query hooks too): read the doc first so the
  // row says what was deleted. Hard deletes may target soft-deleted docs.
  schema.pre('deleteOne', { document: false, query: true }, async function captureDeleted() {
    this.$__auditSkip = skipQuery(this, 'delete');
    if (this.$__auditSkip) return;
    this.$__auditBefore = await readPrior(this, { includeDeleted: true });
  });

  schema.post('deleteOne', { document: false, query: true }, function emitDeleteOne(res) {
    if (!res || !(res.deletedCount > 0)) return;
    const modelName = this.model?.modelName;
    if (this.$__auditBefore) {
      emit('delete', {
        doc: this.$__auditBefore,
        modelName,
        operation: 'deleteOne',
        auditSkip: this.$__auditSkip === true,
      });
      return;
    }
    emit('bulkDelete', {
      modelName,
      operation: 'deleteOne',
      filter: this.getFilter(),
      result: { deletedCount: res.deletedCount },
      auditSkip: this.$__auditSkip === true,
    });
  });

  /* ------------------------------- bulk queries ------------------------------ */

  for (const op of ['updateOne', 'updateMany', 'replaceOne']) {
    schema.post(op, { document: false, query: true }, function emitBulkUpdate(res) {
      if (!res) return;
      const modified = res.modifiedCount ?? 0;
      const upserted = res.upsertedCount ?? (res.upsertedId ? 1 : 0);
      if (modified === 0 && upserted === 0) return;
      const update = this.getUpdate();
      emit('bulkUpdate', {
        modelName: this.model?.modelName,
        operation: op,
        filter: this.getFilter(),
        update,
        result: {
          matchedCount: res.matchedCount ?? 0,
          modifiedCount: modified,
          upsertedCount: upserted,
          upsertedId: res.upsertedId ?? null,
        },
        auditSkip: skipQuery(this, 'bulkUpdate', op === 'replaceOne' ? undefined : update),
      });
    });
  }

  // `Model.insertMany()` bypasses the save hooks: one summary row per call.
  schema.post('insertMany', function emitBulkCreate(docs) {
    const inserted = Array.isArray(docs) ? docs : [];
    if (inserted.length === 0) return;
    const modelName = this.modelName ?? this.model?.modelName;
    const tenants = new Set(inserted.map((d) => (d?.tenantId != null ? String(d.tenantId) : null)));
    emit('bulkCreate', {
      modelName,
      operation: 'insertMany',
      tenantId: tenants.size === 1 ? [...tenants][0] : null,
      result: {
        insertedCount: inserted.length,
        ids: inserted.slice(0, 50).map((d) => String(d?._id)),
      },
      auditSkip: !recordsEvent(getAuditPolicy(modelName), 'bulkCreate'),
    });
  });

  schema.post('deleteMany', { document: false, query: true }, function emitBulkDelete(res) {
    if (!res || !(res.deletedCount > 0)) return;
    emit('bulkDelete', {
      modelName: this.model?.modelName,
      operation: 'deleteMany',
      filter: this.getFilter(),
      result: { deletedCount: res.deletedCount },
      auditSkip: skipQuery(this, 'bulkDelete'),
    });
  });

  /* ---------------------------- soft delete hooks ---------------------------- */

  // Hook into softDelete / restore when the soft-delete plugin is present.
  if (schema.methods?.softDelete) {
    const original = schema.methods.softDelete;
    schema.methods.softDelete = function patched(byUserId) {
      emit('softDelete', {
        doc: this,
        modelName: this.constructor?.modelName,
        actor: resolveActor() ?? (byUserId ? { type: 'system', id: String(byUserId) } : null),
      });
      return original.call(this, byUserId);
    };
  }
  if (schema.methods?.restore) {
    const original = schema.methods.restore;
    schema.methods.restore = function patched() {
      emit('restore', { doc: this, modelName: this.constructor?.modelName });
      return original.call(this);
    };
  }
}

export default audit;
