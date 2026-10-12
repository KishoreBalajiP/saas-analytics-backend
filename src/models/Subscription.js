/**
 * Subscription (Phase 6 - implemented).
 *
 * PURPOSE
 *   The single authoritative commercial relationship between a tenant and
 *   a plan. Exactly one subscription row per tenant. The lifecycle is
 *   distinct from the tenant operational lifecycle (`pending | active |
 *   suspended | disabled | archived`) and is owned by
 *   `services/subscription.service.js`.
 *
 * WHY ONE ROW PER TENANT
 *   Plan changes are a sequential history of a single commercial
 *   relationship, not a parallel set of subscriptions. A `previousPlanId`
 *   field tracks the most recent change; the full history is preserved
 *   by `SubscriptionHistory`.
 *
 * LIFECYCLE
 *   trialing | active | past_due | canceled | expired | restricted
 *
 *   Allowed transitions are encoded in `services/subscription.service.js`
 *   (`assertTransition`). The schema is permissive about field values; the
 *   service is the only authority for the state graph.
 *
 * PLUGINS
 *   optimisticConcurrency, paginate, audit (module `iam.subscriptions`).
 *   Deliberately NOT `tenantScope`: the subscription is the single
 *   canonical record per tenant; the repository scopes by `tenantId`
 *   explicitly so the entitlement service can answer "what is this
 *   tenant's subscription" in one query.
 *
 * INDEXES
 *   - unique(tenantId)
 *   - { state: 1, currentPeriodEnd: 1 }   (background jobs)
 *   - { planId: 1 }
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Subscription';

/** Canonical subscription lifecycle states. */
export const SUBSCRIPTION_STATES = Object.freeze([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
  'restricted',
]);

const subscriptionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true, index: true },
    planId: { type: String, required: true, index: true },
    state: { type: String, enum: [...SUBSCRIPTION_STATES], required: true, index: true },
    trialEndsAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    graceEndsAt: { type: Date, default: null, index: true },
    canceledAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    paymentProvider: { type: String, default: null },
    paymentReference: { type: String, default: null },
    previousPlanId: { type: String, default: null },
    previousState: { type: String, default: null },
    stateChangedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

subscriptionSchema.index({ state: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ state: 1, graceEndsAt: 1 });

subscriptionSchema.plugin(paginate);
subscriptionSchema.plugin(optimisticConcurrency);
subscriptionSchema.plugin(audit, { module: 'iam.subscriptions' });

export const SubscriptionSchema = subscriptionSchema;
export const Subscription = mongoose.model(MODEL_NAME, subscriptionSchema);
export default Subscription;
