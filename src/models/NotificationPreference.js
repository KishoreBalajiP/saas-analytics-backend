/**
 * NotificationPreference (onboarding, roadmap 3.6).
 *
 * PURPOSE
 *   Per-user notification channel preferences with typed keys. One document
 *   per (tenantId, userId). Missing documents mean the defaults
 *   (`NOTIFICATION_CHANNEL_DEFAULTS`). The notification senders (alert
 *   dispatch) consult these before delivering.
 *
 * INDEXES
 *   - unique({ tenantId: 1, userId: 1 })
 */

import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

export const MODEL_NAME = 'NotificationPreference';
export const NOTIFICATION_CHANNELS = Object.freeze(['in_app', 'email']);
export const NOTIFICATION_CHANNEL_DEFAULTS = Object.freeze({ in_app: true, email: true });

const schema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    channels: {
      in_app: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

schema.index({ tenantId: 1, userId: 1 }, { unique: true });
schema.plugin(tenantScope);

export const NotificationPreferenceSchema = schema;
export const NotificationPreference = mongoose.model(MODEL_NAME, schema);
export default NotificationPreference;
