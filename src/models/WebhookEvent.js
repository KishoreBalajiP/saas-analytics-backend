import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

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
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

webhookEventSchema.plugin(paginate);
webhookEventSchema.plugin(optimisticConcurrency);
webhookEventSchema.plugin(audit, { module: 'billing.webhooks' });

const WebhookEvent =
  mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', webhookEventSchema);

export default WebhookEvent;
