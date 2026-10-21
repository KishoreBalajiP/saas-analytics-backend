/**
 * Billing test helpers (billing, roadmap 3.1).
 *
 * WHY IT EXISTS
 *   Plan features are enforced server-side (`requireFeature`) and a tenant
 *   without a subscription resolves the free plan. Tests that exercise a
 *   paid feature (embeds, the external API, report schedules, ...) put
 *   their tenant on a plan that includes it, instead of weakening the gate.
 *
 * USAGE
 *   import { entitleTenant } from '../helpers/billing.js';
 *   await entitleTenant(tenantId);              // enterprise, active term
 *   await entitleTenant(tenantId, 'starter');
 */

import subscriptionService from '../../src/services/subscription.service.js';
import { Subscription } from '../../src/models/Subscription.js';

/**
 * Put `tenantId` on `planCode` with an active term (default 30 days).
 * Works without a seeded catalogue: default plan codes resolve their
 * reference definitions. Idempotent.
 */
export async function entitleTenant(tenantId, planCode = 'enterprise', { days = 30 } = {}) {
  const id = String(tenantId);
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  // Upsert directly: some tests use bare tenant ids without a Tenant row.
  await Subscription.updateOne(
    { tenantId: id },
    {
      $set: {
        planId: planCode,
        state: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: end,
        adminHold: false,
        scheduledChange: null,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        updatedBy: 'test',
      },
      $setOnInsert: { tenantId: id, createdBy: 'test' },
    },
    { upsert: true },
  );
  return subscriptionService.getForTenant(id);
}

export default { entitleTenant };
