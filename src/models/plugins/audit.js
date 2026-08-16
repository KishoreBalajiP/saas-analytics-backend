/**
 * Mongoose plugin: audit.
 *
 * WHY IT EXISTS
 *   Governance (Sprint 8) needs to know who changed what and when. This
 *   plugin emits lightweight domain events for every create/update/soft-
 *   delete/restore on the model. `services/auditConsumer.service.js`
 *   subscribes (via `auditRegistry` below) and persists them to
 *   `AuditLog` through `services/auditLog.service.js`.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(audit, { module: 'iam.users' });
 *   ```
 *
 * EVENTS
 *   The plugin uses the Node `EventEmitter` API on the schema so consumers
 *   subscribe with `Model.events.on('create', ({ module, doc, actor }) => {...})`.
 *
 *   - `create`    - emitted after a document is saved for the first time.
 *   - `update`    - emitted after an update via `save()` or `findOneAndUpdate`.
 *   - `softDelete`- emitted when `softDelete()` removes the document.
 *   - `restore`   - emitted when `restore()` brings a document back.
 *
 * ACTOR
 *   The actor is resolved from `utils/actorContext.js` (AsyncLocalStorage
 *   populated by the auth middleware), falling back to the optional
 *   `Actor` model's `current` static, then `null` (the consumer records
 *   `system`). Never a fabricated identity.
 *
 * HOW TO EXTEND
 *   - Apply the plugin to a model with a `module` tag; the model is
 *     registered in `auditRegistry` and automatically consumed on the next
 *     `initAuditConsumer()` call (or lazily via the registry's replay).
 */

import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { getCurrentActor } from '../../utils/actorContext.js';

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
    emitter.emit(event, { module: opts.module, doc, actor: resolveActor() });
  });

  schema.post('findOneAndUpdate', function (doc) {
    if (!doc) return;
    emitter.emit('update', {
      module: opts.module,
      doc,
      // `findOneAndUpdate` with `lean: true` returns a plain object, so the
      // consumer cannot read `doc.constructor.modelName` - hand it over.
      modelName: this.model?.modelName,
      actor: resolveActor(),
    });
  });

  schema.post('init', function (doc) {
    // capture initial state so we can diff in the update handler.
    doc.$__initialState = doc.toObject();
  });

  // Hook into softDelete / restore when the soft-delete plugin is present.
  if (schema.methods?.softDelete) {
    const original = schema.methods.softDelete;
    schema.methods.softDelete = function patched(byUserId) {
      emitter.emit('softDelete', {
        module: opts.module,
        doc: this,
        actor: resolveActor() ?? (byUserId ? { type: 'system', id: String(byUserId) } : null),
      });
      return original.call(this, byUserId);
    };
  }
  if (schema.methods?.restore) {
    const original = schema.methods.restore;
    schema.methods.restore = function patched() {
      emitter.emit('restore', { module: opts.module, doc: this, actor: resolveActor() });
      return original.call(this);
    };
  }
}

export default audit;
