/**
 * OutboundEmail (roadmap 2.7 - email outbox).
 *
 * PURPOSE
 *   One durable record per email the platform sends. Callers enqueue a
 *   template key plus variables (`services/outbox.service.js#enqueueEmail`);
 *   the email job claims due records, renders and sends them, and retries
 *   failures with exponential backoff until `maxAttempts`, after which the
 *   record is dead-lettered for an operator.
 *
 * LIFECYCLE
 *   pending -> sending -> sent
 *                     \-> retrying -> sending -> ... -> dead
 *   A `sending` record whose lease (`lockedUntil`) expired (crashed worker)
 *   is claimable again.
 *
 * DESIGN CONSTRAINTS
 *   - `dedupeKey` (hash of tenant + caller idempotency key) is unique, so an
 *     enqueue retried with the same key never creates a second message.
 *   - `variablesEnc` holds the template variables encrypted at rest (they can
 *     carry single-use links); it is cleared once the message is sent.
 *   - `lastError` is sanitised (`utils/sanitizeError.js`): no stack traces,
 *     no credentials.
 *   - Sent and dead records are removed by the cleanup job after
 *     RETENTION_OUTBOX_DAYS.
 *
 * INDEXES
 *   - unique(dedupeKey)
 *   - { status: 1, nextAttemptAt: 1 }   (due scan)
 *   - { status: 1, lockedUntil: 1 }     (expired-lease scan)
 *   - { tenantId: 1, createdAt: -1 }
 *   - { status: 1, updatedAt: 1 }       (retention)
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'OutboundEmail';
export const OUTBOX_STATUSES = Object.freeze(['pending', 'sending', 'retrying', 'sent', 'dead']);
/** Statuses a drain may claim (when due). */
export const OUTBOX_CLAIMABLE_STATUSES = Object.freeze(['pending', 'retrying']);
/** Terminal statuses (eligible for retention). */
export const OUTBOX_TERMINAL_STATUSES = Object.freeze(['sent', 'dead']);

const errorSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    message: { type: String, default: null },
  },
  { _id: false },
);

const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, maxlength: 200 },
    contentType: { type: String, default: 'application/octet-stream', maxlength: 120 },
    // Stored artefact to attach (read from the storage service at send time).
    storageKey: { type: String, default: null, maxlength: 512 },
  },
  { _id: false },
);

const outboundEmailSchema = new mongoose.Schema(
  {
    tenantId: { type: String, default: null },
    to: { type: [String], required: true },
    template: { type: String, required: true, maxlength: 64 },
    variablesEnc: { type: String, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    idempotencyKey: { type: String, required: true, maxlength: 256 },
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: [...OUTBOX_STATUSES], default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 6, min: 1 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: errorSchema, default: null },
    sentAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    messageId: { type: String, default: null },
    // `smtp` or `noop` (no transport configured: nothing left the process).
    transport: { type: String, default: null },
  },
  { timestamps: true },
);

outboundEmailSchema.index({ dedupeKey: 1 }, { unique: true });
outboundEmailSchema.index({ status: 1, nextAttemptAt: 1 });
outboundEmailSchema.index({ status: 1, lockedUntil: 1 });
outboundEmailSchema.index({ tenantId: 1, createdAt: -1 });
outboundEmailSchema.index({ status: 1, updatedAt: 1 });

outboundEmailSchema.plugin(paginate);

export const OutboundEmailSchema = outboundEmailSchema;
export const OutboundEmail = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, outboundEmailSchema);
export default OutboundEmail;
