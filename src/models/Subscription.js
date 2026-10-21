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
 *   billing (roadmap 3.1): prepaid terms. A paid plan is held for the
 *   term bought (`currentPeriodStart..currentPeriodEnd`); the lifecycle
 *   job moves an unrenewed term to `past_due` (grace until `graceEndsAt`)
 *   and then `restricted`; a canceled term becomes `expired`; a trial
 *   ends on the free plan. Access is ALSO computed from state + period on
 *   every check (`subscription.service.js#computeAccess`), so a late job
 *   never extends access. `adminHold` marks an administrative restriction
 *   that money events must not lift; `scheduledChange` is a downgrade (or
 *   a prepaid lower-tier term) that takes effect at `effectiveAt`.
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
    // billing: prepaid-term bookkeeping (roadmap 3.1).
    billingInterval: { type: String, enum: ['month', 'year', null], default: null },
    lastTransactionId: { type: String, default: null },
    adminHold: { type: Boolean, default: false },
    scheduledChange: {
      type: new mongoose.Schema(
        {
          planId: { type: String, required: true },
          effectiveAt: { type: Date, required: true },
          // A prepaid lower-tier term starts at `effectiveAt` and ends here;
          // null for a move to the free plan.
          termEnd: { type: Date, default: null },
          interval: { type: String, default: null },
          transactionId: { type: String, default: null },
          source: { type: String, enum: ['workspace', 'payment', 'admin'], default: 'workspace' },
          requestedBy: { type: String, default: null },
          requestedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
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
