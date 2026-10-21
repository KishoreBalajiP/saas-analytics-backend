/**
 * DeliveryUnsubscribe (delivery, roadmap 3.4).
 *
 * An external recipient who opted out of a tenant's scheduled deliveries
 * (through the signed unsubscribe link). Delivery skips these addresses.
 */

import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

export const MODEL_NAME = 'DeliveryUnsubscribe';

const unsubscribeSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  { timestamps: true },
);

unsubscribeSchema.index({ tenantId: 1, email: 1 }, { unique: true });
unsubscribeSchema.plugin(tenantScope);

export const DeliveryUnsubscribe = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, unsubscribeSchema);
export default DeliveryUnsubscribe;
