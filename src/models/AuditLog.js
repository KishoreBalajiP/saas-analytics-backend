/**
 * AuditLog (Sprint 2 - implemented; roadmap 2.5 - categories, hash chain).
 *
 * PURPOSE
 *   Append-only, tamper-evident record of meaningful state changes and
 *   security events. Written ONLY through `services/auditLog.service.js#emit`
 *   (model-change rows from `services/auditConsumer.service.js`, domain
 *   events from services, security events from
 *   `services/securityEvent.service.js`). Read via
 *   `routes/audit-log.routes.js`.
 *
 * CATEGORIES
 *   - `change`   - a data change (model rows, service domain events).
 *   - `security` - a security event (logins, lockouts, MFA, grants, API key
 *     and embed token lifecycle, impersonation, denied requests). The names
 *     live in `constants/securityEvents.js`. Rows written before roadmap 2.5
 *     have no category and count as `change`.
 *
 * TAMPER EVIDENCE (hash chain)
 *   Every row written since roadmap 2.5 carries `seq` (gap-free, unique),
 *   `prevHash` (the previous row's `hash`) and `hash` = SHA-256 (or
 *   HMAC-SHA-256 when `AUDIT_CHAIN_KEY` is set) over `prevHash` and the
 *   canonical JSON of the row (`services/auditChain.service.js`). Editing,
 *   deleting or inserting a row breaks the chain;
 *   `node scripts/ci/verify-audit-chain.js` (read-only) reports where.
 *   With the HMAC key, someone holding only database credentials cannot
 *   rebuild a valid chain after tampering.
 *
 * APPEND-ONLY
 *   - Application level: `pre('save')` rejects updates to existing
 *     documents; `pre` hooks on every update/replace/delete query family and
 *     `bulkWrite` reject the mutation unless the caller explicitly passes
 *     `{ bypassAuditAppendOnly: true }` (only the retention purge in
 *     `repositories/auditLog.repository.js` does).
 *   - Database level (operator action, recommended for production): run the
 *     application with a MongoDB user that may only INSERT and FIND on
 *     `auditlogs`, for example
 *       db.createRole({ role: 'auditAppendOnly', privileges: [
 *         { resource: { db: '<db>', collection: 'auditlogs' },
 *           actions: ['find', 'insert', 'createIndex', 'listIndexes'] } ],
 *         roles: [] })
 *     and grant the app user `readWrite` on every OTHER collection plus
 *     `auditAppendOnly` (a custom role per collection, since built-in
 *     `readWrite` would allow updates). Run the retention purge and
 *     `npm run db:indexes` with a separate, short-lived maintenance user.
 *     This is the control that makes the trail immutable against a
 *     compromised application; the hash chain makes any change that slips
 *     through detectable.
 *   - The `softDelete` / `audit` / `optimisticConcurrency` plugins are
 *     deliberately NOT applied: soft-deleting an audit trail is an
 *     oxymoron, and auditing the audit log would recurse.
 *
 * INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { actorId: 1, occurredAt: -1 }
 *   - { module: 1, action: 1, occurredAt: -1 }
 *   - { category: 1, occurredAt: -1 }
 *   - { seq: 1 } unique (rows that carry a sequence number)
 *   - { requestId: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AuditLog';
export const APPEND_ONLY = true;
export const ACTOR_TYPES = Object.freeze(['admin', 'user', 'service', 'system']);
export const RESULTS = Object.freeze(['success', 'failure']);
export const CATEGORIES = Object.freeze(['change', 'security']);
export const SEVERITIES = Object.freeze(['info', 'notice', 'warning', 'critical']);
export const HASH_ALGORITHMS = Object.freeze(['sha256', 'hmac-sha256']);

const auditLogSchema = new mongoose.Schema(
  {
    category: { type: String, enum: [...CATEGORIES], default: 'change' },
    severity: { type: String, enum: [...SEVERITIES], default: null },
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
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null, index: true },
    result: { type: String, enum: [...RESULTS], default: 'success', required: true },
    errorCode: { type: String, default: null },
    // support: operator (admin) id when the actor was a tenant user acting
    // through a read-only support session (roadmap 2.3 attribution).
    impersonatedBy: { type: String, default: null },
    // Tamper evidence (see header). Absent on rows written before 2.5.
    seq: { type: Number, default: undefined },
    prevHash: { type: String, default: undefined },
    hash: { type: String, default: undefined },
    hashAlg: { type: String, enum: [...HASH_ALGORITHMS], default: undefined },
    keyId: { type: String, default: undefined },
  },
  { timestamps: { createdAt: 'occurredAt', updatedAt: false }, minimize: false },
);

auditLogSchema.index({ tenantId: 1, occurredAt: -1 });
auditLogSchema.index({ actorId: 1, occurredAt: -1 });
auditLogSchema.index({ module: 1, action: 1, occurredAt: -1 });
auditLogSchema.index({ category: 1, occurredAt: -1 });
auditLogSchema.index(
  { seq: 1 },
  { unique: true, partialFilterExpression: { seq: { $type: 'number' } } },
);

function appendOnlyError() {
  const error = new Error('AuditLog is append-only; use the retention purge path');
  error.code = 'APPEND_ONLY';
  return error;
}

function rejectMutation() {
  const options = this.getOptions ? this.getOptions() : (this.options ?? {});
  if (options.bypassAuditAppendOnly === true) return;
  throw appendOnlyError();
}

// Reject `save()` on an already-persisted document.
auditLogSchema.pre('save', function rejectSave(next) {
  if (!this.isNew) {
    return next(Object.assign(new Error('AuditLog is append-only'), { code: 'APPEND_ONLY' }));
  }
  next();
});

// Reject all update/replace/delete query families unless explicitly bypassed.
for (const op of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
]) {
  auditLogSchema.pre(op, { document: false, query: true }, rejectMutation);
}
// Document-level `doc.deleteOne()` / `doc.updateOne()`.
auditLogSchema.pre('deleteOne', { document: true, query: false }, function rejectDocDelete() {
  throw appendOnlyError();
});
auditLogSchema.pre('updateOne', { document: true, query: false }, function rejectDocUpdate() {
  throw appendOnlyError();
});
// `Model.bulkWrite()` may carry update/delete operations; inserts must go
// through the repository so they are chained.
auditLogSchema.pre('bulkWrite', function rejectBulkWrite(next) {
  next(appendOnlyError());
});

// List/export support only - no write plugins.
auditLogSchema.plugin(paginate);

export const AuditLogSchema = auditLogSchema;
export const AuditLog = mongoose.model(MODEL_NAME, auditLogSchema);
export default AuditLog;
