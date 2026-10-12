/**
 * SubscriptionHistory (Phase 6 - implemented).
 *
 * PURPOSE
 *   Append-only audit trail of every subscription state transition and
 *   plan change. One row per transition. Used by the platform-admin
 *   subscription timeline view and as the authoritative source for
 *   "what changed and when" reporting. NEVER updated or deleted.
 *
 * PLUGINS
 *   audit (module `iam.subscriptions.history`).
 *
 * INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { tenantId: 1, type: 1 }
 */

import mongoose from 'mongoose';
import { audit } from './plugins/index.js';

export const MODEL_NAME = 'SubscriptionHistory';

/** Event types for the subscription history timeline. */
export const HISTORY_TYPES = Object.freeze([
  'subscription.created',
  'subscription.plan_changed',
  'subscription.state_changed',
  'subscription.canceled',
  'subscription.reactivated',
  'subscription.migrated',
  'subscription.override_applied',
  'subscription.override_revoked',
]);

const subscriptionHistorySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    type: { type: String, enum: [...HISTORY_TYPES], required: true },
    fromState: { type: String, default: null },
    toState: { type: String, default: null },
    fromPlanId: { type: String, default: null },
    toPlanId: { type: String, default: null },
    reason: { type: String, default: null },
    actor: {
      type: { type: String, enum: ['admin', 'user', 'system'], default: 'system' },
      id: { type: String, default: null },
    },
    occurredAt: { type: Date, default: () => new Date(), index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: false, minimize: false },
);

subscriptionHistorySchema.index({ tenantId: 1, occurredAt: -1 });
subscriptionHistorySchema.index({ tenantId: 1, type: 1 });

subscriptionHistorySchema.plugin(audit, { module: 'iam.subscriptions.history' });

export const SubscriptionHistorySchema = subscriptionHistorySchema;
export const SubscriptionHistory = mongoose.model(
  MODEL_NAME,
  subscriptionHistorySchema,
);
export default SubscriptionHistory;
