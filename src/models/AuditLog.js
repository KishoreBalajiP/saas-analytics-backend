/**
 * AuditLog (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Append-only record of meaningful state changes. Captured by
 *   `audit.middleware.js` and emitted by services. Read via
 *   `routes/audit-log.routes.js`.
 *
 * APPEND-ONLY
 *   - `pre('save')` rejects updates to existing documents.
 *   - `pre` hooks on update/delete queries reject every mutation unless
 *     the caller explicitly passes `{ bypassAuditAppendOnly: true }`.
 *     Only the retention-purge repository method may set that flag, and
 *     only after the retention window has elapsed.
 *   - The `softDelete` / `audit` / `optimisticConcurrency` plugins are
 *     deliberately NOT applied: soft-deleting an audit trail is an
 *     oxymoron, and auditing the audit log would recurse.
 *
 * INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { actorId: 1, occurredAt: -1 }
 *   - { module: 1, action: 1, occurredAt: -1 }
 *   - { requestId: 1 }
 *
 * STORAGE
 *   - Mongo (with time-series collection in Phase 3+).
 *   - Cold tier (S3) for entries > 30 days old.
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AuditLog';
export const APPEND_ONLY = true;
export const ACTOR_TYPES = Object.freeze(['admin', 'user', 'service', 'system']);
export const RESULTS = Object.freeze(['success', 'failure']);

const auditLogSchema = new mongoose.Schema(
  {
    actorType: {
      type: String,
      enum: [...ACTOR_TYPES],
      default: 'system',
      required: true,
    },
    actorId: { type: String, default: null, index: true },
    actorDisplay: { type: String, default: '' },
    tenantId: { type: String, default: null, index: true },
    module: { type: String, required: true, trim: true },
    action: { type: String, required: true, trim: true },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null, index: true },
    result: { type: String, enum: [...RESULTS], default: 'success', required: true },
    errorCode: { type: String, default: null },
  },
  { timestamps: { createdAt: 'occurredAt', updatedAt: false } },
);

auditLogSchema.index({ tenantId: 1, occurredAt: -1 });
auditLogSchema.index({ actorId: 1, occurredAt: -1 });
auditLogSchema.index({ module: 1, action: 1, occurredAt: -1 });

function rejectMutation() {
  const options = this.getOptions ? this.getOptions() : (this.options ?? {});
  if (options.bypassAuditAppendOnly === true) return;
  const error = new Error('AuditLog is append-only; use the retention purge path');
  error.code = 'APPEND_ONLY';
  throw error;
}

// Reject `save()` on an already-persisted document.
auditLogSchema.pre('save', function rejectSave(next) {
  if (!this.isNew) {
    return next(Object.assign(new Error('AuditLog is append-only'), { code: 'APPEND_ONLY' }));
  }
  next();
});

// Reject all update/delete query families unless explicitly bypassed.
auditLogSchema.pre('updateOne', rejectMutation);
auditLogSchema.pre('updateMany', rejectMutation);
auditLogSchema.pre('findOneAndUpdate', rejectMutation);
auditLogSchema.pre('deleteOne', rejectMutation);
auditLogSchema.pre('deleteMany', rejectMutation);
auditLogSchema.pre('findOneAndDelete', rejectMutation);
auditLogSchema.pre('findOneAndRemove', rejectMutation);

// List/export support only - no write plugins.
auditLogSchema.plugin(paginate);

export const AuditLogSchema = auditLogSchema;
export const AuditLog = mongoose.model(MODEL_NAME, auditLogSchema);
export default AuditLog;
