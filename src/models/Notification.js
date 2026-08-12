/**
 * Notification (Sprint 7 - implemented).
 *
 * PURPOSE
 *   The in-app notification inbox plus an audit record of dispatched emails.
 *   Alert delivery writes one document per recipient/channel so the Tenant
 *   Portal can render an inbox, unread badges, and mark-as-read state.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, audit (module `notifications`).
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'Notification';

const relatedResourceSchema = new mongoose.Schema(
  {
    type: { type: String, default: null },
    id: { type: String, default: null },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    recipientId: { type: String, default: null, index: true },
    recipientEmail: { type: String, default: null },
    channel: { type: String, enum: ['in_app', 'email'], default: 'in_app' },
    type: { type: String, default: 'system' },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    relatedResource: { type: relatedResourceSchema, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ tenantId: 1, recipientId: 1, read: 1 });
notificationSchema.index({ tenantId: 1, recipientEmail: 1, read: 1 });

notificationSchema.plugin(tenantScope);
notificationSchema.plugin(softDelete);
notificationSchema.plugin(paginate);
notificationSchema.plugin(audit, { module: 'notifications' });

export const NotificationSchema = notificationSchema;
export const Notification = mongoose.model(MODEL_NAME, notificationSchema);
export default Notification;
