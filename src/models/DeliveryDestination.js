/**
 * DeliveryDestination (delivery, roadmap 3.4).
 *
 * PURPOSE
 *   A tenant's outbound destination: a signed webhook, a Slack or a
 *   Microsoft Teams incoming-webhook URL. Report schedules and alert rules
 *   reference destinations by id.
 *
 * SECURITY
 *   The URL is a secret (Slack/Teams URLs are bearer credentials): stored
 *   only encrypted (`urlEnc`, `select: false`), never returned; responses
 *   carry the host as `urlHint`. Webhook destinations also hold an HMAC
 *   signing secret (`secretEnc`), shown once at creation.
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate } from './plugins/index.js';

export const MODEL_NAME = 'DeliveryDestination';
export const DESTINATION_TYPES = Object.freeze(['webhook', 'slack', 'teams']);

const destinationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    type: { type: String, enum: [...DESTINATION_TYPES], required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    urlEnc: { type: String, required: true, select: false },
    secretEnc: { type: String, default: null, select: false },
    urlHint: { type: String, default: '' },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

destinationSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.urlEnc;
    delete ret.secretEnc;
    return ret;
  },
});

destinationSchema.plugin(tenantScope);
destinationSchema.plugin(softDelete);
destinationSchema.plugin(paginate);

export const DeliveryDestination = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, destinationSchema);
export default DeliveryDestination;
