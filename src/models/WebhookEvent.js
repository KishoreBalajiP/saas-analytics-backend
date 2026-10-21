/**
 * WebhookEvent (Phase 6.1; billing roadmap 3.1).
 *
 * PURPOSE
 *   Durable record of every signature-verified payment-provider webhook.
 *   The row is the dedupe anchor and the work item: the HTTP handler only
 *   verifies, stores and acknowledges; processing runs from the stored row
 *   (`services/billingWebhook.service.js`) and is retried with backoff
 *   until it succeeds or is given up (`failed`).
 *
 * DEDUPE
 *   `eventId` is Razorpay's `x-razorpay-event-id` header (stable across
 *   redeliveries of the same event). The unique `{ provider, eventId }`
 *   index makes a redelivery a no-op insert.
 *
 * LIFECYCLE
 *   received -> processing -> processed | ignored
 *   processing -> received (retry, `nextAttemptAt` backoff) | failed
 *   `processed` is kept as a boolean mirror for older readers.
 *
 * STORED PAYLOAD
 *   Only the redacted, normalised summary needed to process the event
 *   (event, ids, amount, currency, status, provider timestamp). Never the
 *   signature, card or contact details.
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const WEBHOOK_EVENT_STATUSES = Object.freeze(['received', 'processing', 'processed', 'ignored', 'failed']);

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['razorpay'], required: true, index: true },
    eventId: { type: String, required: true, trim: true, index: true },
    eventType: { type: String, required: true, trim: true, index: true },
    raw: { type: mongoose.Schema.Types.Mixed },
    processed: { type: Boolean, default: false, index: true },
    error: { type: String, trim: true },
    processedAt: { type: Date },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
    // billing: processing state of the stored event.
    status: { type: String, enum: [...WEBHOOK_EVENT_STATUSES], default: 'received', index: true },
    outcome: { type: String, default: null, trim: true },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    leaseUntil: { type: Date, default: null },
    deliveries: { type: Number, default: 1, min: 1 },
    providerCreatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
// billing: the retry sweep picks due, unfinished events.
webhookEventSchema.index({ status: 1, nextAttemptAt: 1 });

webhookEventSchema.plugin(paginate);
webhookEventSchema.plugin(optimisticConcurrency);
webhookEventSchema.plugin(audit, { module: 'billing.webhooks' });

const WebhookEvent =
  mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', webhookEventSchema);

export default WebhookEvent;
