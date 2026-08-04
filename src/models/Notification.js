/**
 * Notification (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   In-app / push / email / webhook notification record. Dispatched by
 *   `services/notification.service.js`.
 *
 * PLANNED FIELDS
 *   _id, tenantId,
 *   actorId (recipient), actorType: 'user' | 'admin',
 *   channel: 'in_app' | 'email' | 'push' | 'webhook',
 *   templateKey,                            // ref: master_data.notification_templates
 *   data: json,                             // template variables
 *   priority: 'low' | 'normal' | 'high',
 *   status: 'queued' | 'delivered' | 'failed' | 'read',
 *   readAt?, deliveredAt?, failedReason?,
 *   groupKey?,                              // collapse duplicates
 *   createdAt
 *
 * PLANNED INDEXES
 *   - { tenantId: 1, actorId: 1, status: 1, createdAt: -1 }
 *   - { tenantId: 1, status: 1, readAt: 1 } (inbox)
 */

export const MODEL_NAME = 'Notification';
export const CHANNELS = Object.freeze([
  'in_app', 'email', 'push', 'webhook',
]);
export const PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const STATUSES = Object.freeze(['queued', 'delivered', 'failed', 'read']);

export default Object.freeze({
  name: MODEL_NAME,
  channels: CHANNELS,
  priorities: PRIORITIES,
  statuses: STATUSES,
  schemaImplemented: false,
  seeAlso: ['src/modules/platform/notifications/README.md'],
});
