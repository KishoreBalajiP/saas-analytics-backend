/**
 * Mongoose plugin: audit.
 *
 * WHY IT EXISTS
 *   Governance (Sprint 7) needs to know who changed what and when. This
 *   plugin emits lightweight domain events for every create/update/soft-
 *   delete on the model. Sprint 7 wires a consumer that persists them to
 *   `AuditLog`.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(audit, { module: 'iam.users' });
 *   ```
 *
 * EVENTS
 *   The plugin uses the Node `EventEmitter` API on the schema so consumers
 *   subscribe with `Model.events.on('create', ({ doc, actor }) => {...})`.
 *
 *   - `create` - emitted after a document is saved for the first time.
 *   - `update` - emitted after an update via `save()` or `findOneAndUpdate`.
 *   - `softDelete` - emitted when `softDelete()` removes the document.
 *   - `restore` - emitted when `restore()` brings a document back.
 *
 * HOW TO EXTEND
 *   - Sprint 7 wires `services/audit.service.js` to subscribe to these
 *     events and persist the structured record.
 */

import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';

const DEFAULT_OPTIONS = Object.freeze({
  /** Logical module name, used by the audit consumer to tag the entry. */
  module: 'unknown',
});

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

  /**
   * Resolve the actor for the current operation. Hooked up by Sprint 7 to
   * the auth middleware (`req.actor`). For Sprint 0 we default to
   * `system`.
   */
  function resolveActor() {
    return mongoose?.models?.Actor?.current ?? null;
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
    emitter.emit(event, { module: opts.module, doc, actor: resolveActor() });
  });

  schema.post('findOneAndUpdate', function (doc) {
    emitter.emit('update', { module: opts.module, doc, actor: resolveActor() });
  });

  schema.post('init', function (doc) {
    // capture initial state so we can diff in the update handler.
    doc.$__initialState = doc.toObject();
  });

  // Hook into softDelete / restore when the soft-delete plugin is present.
  if (schema.methods?.softDelete) {
    const original = schema.methods.softDelete;
    schema.methods.softDelete = function patched(byUserId) {
      emitter.emit('softDelete', { module: opts.module, doc: this, actor: { id: byUserId } });
      return original.call(this, byUserId);
    };
  }
  if (schema.methods?.restore) {
    const original = schema.methods.restore;
    schema.methods.restore = function patched() {
      emitter.emit('restore', { module: opts.module, doc: this });
      return original.call(this);
    };
  }
}

export default audit;
