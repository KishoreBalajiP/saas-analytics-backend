/**
 * Billing lifecycle service (Phase 6.1; billing roadmap 3.1 prepaid terms).
 *
 * PURPOSE
 *   The ONLY place provider-confirmed money events touch the subscription,
 *   and the home of the prepaid-term lifecycle sweep. Webhook processing
 *   and reconciliation funnel captures here; this service only mutates the
 *   subscription through `subscription.service.js` (`applyPaidTerm`,
 *   `advanceLifecycle`), so the state graph (`assertTransition`) is never
 *   bypassed.
 *
 * CAPTURE APPLICATION (findings bil.05 / db.03)
 *   A transaction is flipped to `captured` first and its term applied
 *   second; `appliedAt` marks the second step done. `applyCapture` claims
 *   the row (`applyingUntil`), applies the term (idempotent on the
 *   transaction id stored as `lastTransactionId`), then marks it applied.
 *   A failure releases the claim and records the error; the webhook retry
 *   sweep and reconciliation re-drive every captured-but-unapplied row, so
 *   a charged customer always ends up with the term they paid for.
 *
 * GUARDS
 *   - Suspended / disabled / archived tenants are NEVER activated (the row
 *     stays captured-but-unapplied until the tenant is reinstated).
 *   - A subscription under an administrative hold (`adminHold`) is never
 *     activated by money events.
 *   - Failed payments never grant or remove anything: a prepaid term runs
 *     to its end regardless of a failed attempt to buy the next one.
 *   - Refunds never auto-downgrade: the transaction is marked refunded and
 *     an audit/history trail is written; plan access stays until an admin
 *     acts.
 *
 * LIFECYCLE SWEEP (`runLifecycleSweep`, driven by billingLifecycle.job.js)
 *   Persists what `subscriptionService.computeAccess` already enforces at
 *   read time: term end -> past_due (grace) -> restricted, canceled ->
 *   expired, trial end -> free plan, queued downgrades at the period end;
 *   then sends renewal reminders through the email outbox.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import subscriptionService from './subscription.service.js';
import planService from './plan.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import subscriptionRepository from '../repositories/subscription.repository.js';
import paymentTransactionRepository from '../repositories/paymentTransaction.repository.js';
import { enqueueEmail } from './outbox.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import logger from '../utils/logger.js';

const BLOCKED_TENANT_STATUSES = Object.freeze(['suspended', 'disabled', 'archived']);

/** How long one processor may hold a captured row while applying it. */
export const APPLY_LEASE_MS = 60 * 1000;

const DAY_MS = 86400000;

function systemActor() {
  return { type: 'system', id: 'razorpay-webhook' };
}

async function loadTenantGuard(tenantId) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  if (BLOCKED_TENANT_STATUSES.includes(tenant.status)) {
    throw ApiError.conflict(`Tenant is "${tenant.status}"; provider events cannot activate it`);
  }
  return tenant;
}

/**
 * Apply the prepaid term of a CAPTURED transaction. Idempotent: an applied
 * row, or a row another processor is applying, returns without writing.
 *
 * @param {Object} params
 * @param {Object|string} params.transaction - the transaction row or its id.
 * @param {Object} [params.actor]
 * @param {Date} [params.now]
 * @returns {Promise<{ applied: boolean, idempotent: boolean, mode?: string, subscription?: object, reason?: string }>}
 */
export async function applyCapture({ transaction, actor = null, now = clock.now() } = {}) {
  const id = typeof transaction === 'object' && transaction ? transaction._id : transaction;
  if (!id) throw ApiError.badRequest('transaction is required');
  const who = actor ?? systemActor();
  const current = await paymentTransactionRepository.findById(id);
  if (!current) throw ApiError.notFound('Payment transaction not found');
  if (current.status !== 'captured') {
    return { applied: false, idempotent: true, reason: `transaction_${current.status}` };
  }
  if (current.appliedAt) return { applied: true, idempotent: true, reason: 'already_applied' };

  const claimed = await paymentTransactionRepository.claimForApply(id, { now, leaseMs: APPLY_LEASE_MS });
  if (!claimed) return { applied: false, idempotent: true, reason: 'apply_in_progress' };

  try {
    await loadTenantGuard(String(claimed.tenantId));
    const result = await subscriptionService.applyPaidTerm({
      tenantId: String(claimed.tenantId),
      planId: claimed.planId,
      interval: claimed.interval ?? 'month',
      termMonths: claimed.termMonths ?? 1,
      transactionId: String(claimed._id),
      providerRef: claimed.providerOrderId,
      paymentId: claimed.providerPaymentId ?? null,
      actor: who,
      now,
    });
    await paymentTransactionRepository.markApplied(id, { at: now });
    return { applied: true, idempotent: result.idempotent, mode: result.mode, subscription: result.subscription };
  } catch (err) {
    await paymentTransactionRepository.releaseApply(id, { error: err?.message ?? 'apply_failed' }).catch(() => {});
    throw err;
  }
}

/**
 * Record a verified payment failure. Never changes access: in the prepaid
 * model a failed attempt to buy a term leaves the current term untouched.
 */
export async function applyFailure({ tenantId, providerRef, reason = null, actor = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!providerRef) throw ApiError.badRequest('providerRef is required');
  const who = actor ?? systemActor();

  const sub = await subscriptionService.getForTenant(tenantId);
  if (!sub) {
    logger.info({ tenantId }, 'Payment failure for tenant without subscription; recorded only');
    return { applied: true, idempotent: false, subscription: null, note: 'no_subscription' };
  }
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.payment_failed',
    fromState: sub.state,
    toState: sub.state,
    fromPlanId: sub.planId,
    toPlanId: sub.planId,
    reason: reason ?? `Razorpay payment failed (${providerRef})`,
    actor: who,
    metadata: { providerRef },
  });
  return { applied: true, idempotent: false, subscription: sub, note: 'recorded' };
}

/**
 * Apply a verified refund. Marks the trail and leaves plan access for an
 * explicit admin decision (no silent downgrade, no data loss).
 */
export async function applyRefund({ tenantId, providerRef, actor = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!providerRef) throw ApiError.badRequest('providerRef is required');
  const who = actor ?? systemActor();

  const sub = await subscriptionService.getForTenant(tenantId);
  if (sub) {
    await subscriptionRepository.appendHistory(tenantId, {
      type: 'subscription.payment_refunded',
      fromState: sub.state,
      toState: sub.state,
      fromPlanId: sub.planId,
      toPlanId: sub.planId,
      reason: `Razorpay refund processed (${providerRef}); access retained pending admin review`,
      actor: who,
      metadata: { providerRef },
    });
  }
  await auditEmit({
    actor: who,
    action: 'subscription.payment_refunded',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: sub ? String(sub.id) : tenantId },
    tenantId,
    after: { providerRef },
    metadata: { note: 'access_retained_pending_admin_review' },
  });
  return { applied: true, idempotent: false, subscription: sub ?? null };
}

/* ------------------------------ lifecycle -------------------------------- */

/** Where billing mail for a tenant goes: the billing email, else the owner. */
async function billingRecipient(tenant) {
  if (tenant?.billingEmail) return tenant.billingEmail;
  if (!tenant?.ownerId) return null;
  const owner = await userRepository.findById(tenant.ownerId).catch(() => null);
  return owner?.email && owner.status !== 'deleted' ? owner.email : null;
}

function formatDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Enqueue renewal reminders for paid terms ending within the largest
 * configured offset. One email per (subscription, period end, offset): the
 * outbox idempotency key makes re-runs no-ops. When several offsets have
 * passed (job was down), only the most urgent one is sent.
 *
 * @returns {Promise<{ remindersQueued: number, remindersSkipped: number }>}
 */
export async function sendRenewalReminders({ now = clock.now(), offsets = env.billing.renewalReminderDays } = {}) {
  const counts = { remindersQueued: 0, remindersSkipped: 0 };
  const days = [...(offsets ?? [])].filter((d) => Number.isInteger(d) && d > 0).sort((a, b) => a - b);
  if (days.length === 0) return counts;
  const until = new Date(now.getTime() + days[days.length - 1] * DAY_MS);
  const due = await subscriptionRepository.listRenewalDue({ now, until });
  for (const sub of due) {
    try {
      if (planService.isFreePlan(sub.planId)) continue;
      // A queued move to the free plan means the workspace chose not to renew.
      if (sub.scheduledChange && planService.isFreePlan(sub.scheduledChange.planId)) continue;
      const end = new Date(sub.currentPeriodEnd);
      const remainingMs = end.getTime() - now.getTime();
      const offset = days.find((d) => remainingMs <= d * DAY_MS);
      if (!offset) continue;
      const tenant = await tenantRepository.findById(sub.tenantId);
      if (!tenant || tenant.deletedAt || BLOCKED_TENANT_STATUSES.includes(tenant.status)) {
        counts.remindersSkipped += 1;
        continue;
      }
      const to = await billingRecipient(tenant);
      if (!to) {
        counts.remindersSkipped += 1;
        continue;
      }
      const { plan } = await planService.resolveByCode(sub.planId);
      const result = await enqueueEmail({
        tenantId: String(sub.tenantId),
        to,
        template: sub.state === 'trialing' ? 'billing.trial_ending' : 'billing.renewal_reminder',
        variables: {
          tenantName: tenant.name ?? 'your workspace',
          planName: plan?.data?.displayName ?? plan?.name ?? sub.planId,
          periodEnd: formatDay(end),
          daysLeft: String(Math.max(1, Math.ceil(remainingMs / DAY_MS))),
          billingUrl: `${env.cors.clientUrl}/billing`,
        },
        idempotencyKey: `billing.reminder:${String(sub._id)}:${end.toISOString()}:${offset}`,
      });
      if (result?.duplicate) counts.remindersSkipped += 1;
      else counts.remindersQueued += 1;
    } catch (err) {
      counts.remindersSkipped += 1;
      logger.warn({ err: { message: err?.message }, tenantId: sub.tenantId }, 'Billing reminder failed');
    }
  }
  return counts;
}

/**
 * Notify the workspace when its term lapsed into the grace window.
 * Idempotent per subscription and period end.
 */
async function sendGraceNotice({ subscription, now }) {
  const tenant = await tenantRepository.findById(subscription.tenantId);
  const to = await billingRecipient(tenant);
  if (!to) return false;
  const { plan } = await planService.resolveByCode(subscription.planId);
  await enqueueEmail({
    tenantId: String(subscription.tenantId),
    to,
    template: 'billing.payment_overdue',
    variables: {
      tenantName: tenant?.name ?? 'your workspace',
      planName: plan?.data?.displayName ?? plan?.name ?? subscription.planId,
      graceEndsAt: formatDay(subscription.graceEndsAt ?? now),
      billingUrl: `${env.cors.clientUrl}/billing`,
    },
    idempotencyKey: `billing.overdue:${subscription.id}:${new Date(subscription.currentPeriodEnd).toISOString()}`,
  });
  return true;
}

/**
 * The lifecycle job's work: advance every subscription whose term, trial
 * or grace window ended, then queue renewal reminders. Per-row failures
 * are counted and never stop the sweep.
 *
 * @returns {Promise<Object>} numeric counts (stored on the JobRun).
 */
export async function runLifecycleSweep({ now = clock.now(), limit = 200 } = {}) {
  const counts = {
    checked: 0,
    pastDue: 0,
    restricted: 0,
    expired: 0,
    trialsEnded: 0,
    scheduledApplied: 0,
    rolled: 0,
    errors: 0,
  };
  const due = await subscriptionRepository.listLifecycleDue({ now, limit });
  for (const sub of due) {
    counts.checked += 1;
    try {
      const { action, subscription } = await subscriptionService.advanceLifecycle({ tenantId: sub.tenantId, now });
      if (action === 'past_due') {
        counts.pastDue += 1;
        await sendGraceNotice({ subscription, now }).catch((err) => {
          logger.warn({ err: { message: err?.message }, tenantId: sub.tenantId }, 'Billing grace notice failed');
        });
      } else if (action === 'restricted') counts.restricted += 1;
      else if (action === 'expired') counts.expired += 1;
      else if (action === 'trial_ended') counts.trialsEnded += 1;
      else if (action === 'scheduled_applied') counts.scheduledApplied += 1;
      else if (action === 'rolled') counts.rolled += 1;
    } catch (err) {
      counts.errors += 1;
      logger.warn({ err: { message: err?.message }, tenantId: sub.tenantId }, 'Billing lifecycle step failed');
    }
  }
  const reminders = await sendRenewalReminders({ now });
  return { ...counts, ...reminders };
}

/* ------------------------------ migration -------------------------------- */

/**
 * One-off move of pre-3.1 subscriptions onto the prepaid-term model
 * (operator step `npm run db:billing-terms`, dry run by default).
 *
 * Before 3.1 a paid plan never expired and lazy provisioning put unpaid
 * tenants on `starter`. Computing access from the period would restrict
 * them at once, so this migration:
 *   - moves ACTIVE paid-plan rows that were never paid (no payment
 *     reference, no applied transaction) to the free plan;
 *   - gives every other active / canceled paid row whose term ends within
 *     `noticeDays` a notice term until `now + noticeDays`, so renewal
 *     reminders go out before anything lapses;
 *   - leaves trials, past_due, restricted and expired rows alone.
 * Every write is a compare-and-set with a `subscription.migrated` history row.
 *
 * @returns {Promise<{ scanned: number, movedToFree: number, noticeExtended: number, unchanged: number, errors: number, dryRun: boolean }>}
 */
export async function migrateLegacySubscriptions({
  dryRun = true,
  now = clock.now(),
  noticeDays = 30,
  by = 'billing-migration',
  log = null,
} = {}) {
  const counts = { scanned: 0, movedToFree: 0, noticeExtended: 0, unchanged: 0, errors: 0, dryRun };
  const actor = { type: 'system', id: by };
  const noticeEnd = new Date(now.getTime() + Math.max(1, noticeDays) * DAY_MS);
  let afterId = null;
  for (;;) {
    const page = await subscriptionRepository.listPaidPage({ afterId, limit: 200 });
    if (page.length === 0) break;
    afterId = page[page.length - 1]._id;
    for (const sub of page) {
      counts.scanned += 1;
      try {
        const paid = Boolean(sub.lastTransactionId || sub.paymentReference);
        const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
        let action = 'unchanged';
        let patch = null;
        if (!paid && sub.state === 'active') {
          action = 'movedToFree';
          patch = {
            planId: planService.DEFAULT_PLAN_CODE,
            previousPlanId: sub.planId,
            currentPeriodStart: now,
            currentPeriodEnd: subscriptionService.addMonths(now, 1),
            scheduledChange: null,
            stateChangedAt: now,
          };
        } else if (['active', 'canceled'].includes(sub.state) && (!end || end.getTime() < noticeEnd.getTime() - DAY_MS)) {
          // (one day of slack keeps a re-run from extending again)
          action = 'noticeExtended';
          patch = { currentPeriodEnd: noticeEnd };
        }
        counts[action] += 1;
        log?.(`${dryRun ? 'would' : 'did'} ${action} ${sub.tenantId} (${sub.planId}, ${sub.state})`);
        if (dryRun || !patch) continue;
        const updated = await subscriptionRepository.update(sub._id, patch, { by, expect: { updatedAt: sub.updatedAt } });
        if (!updated) {
          counts[action] -= 1;
          counts.errors += 1;
          continue;
        }
        await subscriptionRepository.appendHistory(sub.tenantId, {
          type: 'subscription.migrated',
          fromState: sub.state,
          toState: updated.state,
          fromPlanId: sub.planId,
          toPlanId: updated.planId,
          reason: action === 'movedToFree'
            ? 'Prepaid-term migration: never-paid plan moved to the free plan'
            : `Prepaid-term migration: notice term until ${noticeEnd.toISOString().slice(0, 10)}`,
          actor,
          metadata: { action, previousPeriodEnd: sub.currentPeriodEnd ?? null },
        });
      } catch (err) {
        counts.errors += 1;
        logger.warn({ err: { message: err?.message }, tenantId: sub.tenantId }, 'Billing migration step failed');
      }
    }
  }
  return counts;
}

export default {
  migrateLegacySubscriptions,
  applyCapture,
  applyFailure,
  applyRefund,
  sendRenewalReminders,
  runLifecycleSweep,
  APPLY_LEASE_MS,
  _meta: { module: 'billing.lifecycle' },
};
