/**
 * Subscription service (Phase 6 - implemented).
 *
 * PURPOSE
 *   The lifecycle authority for tenant subscriptions. Owns the state
 *   graph (`assertTransition`), writes through the optimistic-
 *   concurrency-aware repository, appends an immutable history row
 *   for every transition, and emits an `iam.subscriptions.*` audit
 *   event.
 *
 * RESPONSIBILITY
 *   - createForTenant({ tenantId, planId, actor, by })
 *   - getForTenant(tenantId)
 *   - changePlan({ tenantId, planId, actor, by, reason })
 *   - cancel({ tenantId, actor, by, immediate, reason })
 *   - reactivate({ tenantId, planId?, actor, by, reason })
 *   - setState({ tenantId, state, graceEndsAt?, actor, by, reason })   admin
 *   - list(opts)                                                      admin
 *   billing (roadmap 3.1, prepaid terms):
 *   - computeAccess(sub, { now, graceDays })    effective state on every check
 *   - ensureForTenant({ tenantId })             default provisioning (free,
 *                                               or a plan trial)
 *   - applyPaidTerm({ ... })                    renew / upgrade / queue a term
 *   - scheduleChange / clearScheduledChange      downgrade at period end
 *   - advanceLifecycle({ tenantId, now })       the lifecycle job's step
 *   - listForTenant(tenantId, opts)                                   timeline
 *   - assertTransition(from, to)                                      the
 *                                                                     only
 *                                                                     place
 *                                                                     the
 *                                                                     state
 *                                                                     graph
 *                                                                     lives
 *
 * CODING GUIDELINES
 *   - Lifecycle transitions NEVER bypass `assertTransition`. There is
 *     no `update({ state: ... })` escape hatch.
 *   - Plan changes preserve `previousPlanId` and append a history row.
 *   - All writes are audit-logged through `auditLogService.emit`.
 *   - The service does NOT validate the plan code (it accepts any
 *     string). Plan validation is the responsibility of `planService`
 *     and the workspace controller that funnels `planId` from the
 *     public catalogue. The `entitlementService` resolves the
 *     authoritative plan and short-circuits missing plans to the
 *     safe-fallback plan.
 */

import ApiError from '../utils/ApiError.js';
import subscriptionRepository from '../repositories/subscription.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import { emit as auditEmit } from './auditLog.service.js';
import { SUBSCRIPTION_STATES } from '../models/Subscription.js';
import planService, { DEFAULT_PLAN_CODE } from './plan.service.js';
import clock from '../utils/clock.js';
import env from '../config/env.js';

/**
 * The single source of truth for the subscription state graph.
 * Every transition in the codebase MUST go through this function.
 *
 * @param {string|null} from
 * @param {string} to
 */
export function assertTransition(from, to) {
  if (!to) throw ApiError.badRequest('Target state is required');
  if (!SUBSCRIPTION_STATES.includes(to)) {
    throw ApiError.badRequest(`Unknown subscription state "${to}"`);
  }
  if (from === to) {
    // Idempotent re-application of the same state is allowed.
    return { from, to, allowed: true, idempotent: true };
  }
  if (from === null) {
    // Creation: from null, any of trialing | active | past_due are allowed.
    if (to === 'trialing' || to === 'active' || to === 'past_due') {
      return { from, to, allowed: true };
    }
    throw ApiError.conflict(`Cannot create a subscription in state "${to}"`);
  }
  if (!SUBSCRIPTION_STATES.includes(from)) {
    throw ApiError.badRequest(`Unknown current state "${from}"`);
  }

  // The state graph is intentionally permissive on `* -> restricted`
  // because the platform-admin `setState` endpoint is the only caller
  // for those transitions and it requires the
  // `billing.subscriptions.override` permission. The table encodes
  // the public self-service graph; admin transitions are layered on
  // top by the same `assertTransition` because the route gate is the
  // authorization boundary, not a parallel state graph.
  const table = {
    trialing: new Set(['active', 'canceled', 'expired', 'restricted', 'past_due']),
    active: new Set(['past_due', 'canceled', 'restricted', 'expired']),
    past_due: new Set(['active', 'canceled', 'expired', 'restricted']),
    canceled: new Set(['expired', 'active', 'restricted']),
    expired: new Set(['active', 'restricted']),
    restricted: new Set(['active', 'canceled']),
  };
  if (!table[from] || !table[from].has(to)) {
    throw ApiError.conflict(
      `Subscription transition "${from}" -> "${to}" is not allowed`,
    );
  }
  return { from, to, allowed: true };
}

function actorOf(by) {
  return by ? { type: 'admin', id: by } : { type: 'system', id: 'system' };
}

function asActor(by) {
  return by ?? null;
}

function defaultPeriodWindow(now = clock.now()) {
  const start = new Date(now);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 30);
  return { start, end };
}

const DAY_MS = 86400000;

/**
 * billing: add calendar months in UTC, clamping to the last day of the
 * target month (Jan 31 + 1 month = Feb 28/29).
 */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** billing: grace days after a paid term ends (plan value, else env default). */
export function graceDaysFor(plan) {
  const days = plan?.data?.graceDays;
  if (Number.isInteger(days) && days >= 0) return days;
  return env.billing?.defaultGraceDays ?? 7;
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * billing (finding bil.04): the effective subscription state, computed from
 * the stored state AND the period on every check, so access never outlives
 * the term even when the lifecycle job is late. Pure: no I/O.
 *
 *   - free plan: perpetual (only an admin `restricted` hold applies)
 *   - trialing: the plan until the trial ends, then the free plan
 *   - active (paid): the plan until `currentPeriodEnd`; then a due
 *     scheduled change; else `past_due` for the grace window; then
 *     `restricted`
 *   - past_due: the plan until `graceEndsAt`, then `restricted`
 *   - canceled: the plan until `currentPeriodEnd`, then `expired`
 *   - expired / restricted: write-blocked
 *
 * @param {Object|null} sub - stored (lean or shaped) subscription.
 * @param {{ now?: Date, graceDays?: number }} [opts]
 * @returns {{ state: string, planId: string, writeBlocked: boolean, inGrace: boolean,
 *   graceEndsAt: Date|null, periodEnded: boolean, reason: string|null }}
 */
export function computeAccess(sub, { now = clock.now(), graceDays = env.billing?.defaultGraceDays ?? 7 } = {}) {
  const at = toDate(now) ?? new Date();
  const result = (state, planId, extra = {}) => ({
    state,
    planId,
    writeBlocked: state === 'expired' || state === 'restricted',
    inGrace: false,
    graceEndsAt: null,
    periodEnded: false,
    reason: null,
    ...extra,
  });
  if (!sub) return result('active', DEFAULT_PLAN_CODE, { reason: 'no_subscription' });
  const planId = sub.planId ?? DEFAULT_PLAN_CODE;
  const periodEnd = toDate(sub.currentPeriodEnd);
  const ended = !periodEnd || at.getTime() >= periodEnd.getTime();

  if (planService.isFreePlan(planId)) {
    if (sub.state === 'restricted' && sub.adminHold === true) return result('restricted', planId, { reason: 'admin_hold' });
    return result('active', planId);
  }
  if (sub.state === 'restricted') return result('restricted', planId, { reason: sub.adminHold ? 'admin_hold' : 'unpaid' });
  if (sub.state === 'expired') return result('expired', planId, { periodEnded: true });

  if (sub.state === 'trialing') {
    const trialEnd = toDate(sub.trialEndsAt) ?? periodEnd;
    if (trialEnd && at.getTime() < trialEnd.getTime()) return result('trialing', planId);
    return result('active', DEFAULT_PLAN_CODE, { periodEnded: true, reason: 'trial_ended' });
  }
  if (sub.state === 'canceled') {
    if (!ended) return result('canceled', planId);
    return result('expired', planId, { periodEnded: true, reason: 'canceled' });
  }

  // active | past_due on a paid plan.
  if (sub.state === 'active' && !ended) return result('active', planId);
  const change = sub.scheduledChange;
  const effectiveAt = toDate(change?.effectiveAt);
  if (sub.state === 'active' && change?.planId && effectiveAt && at.getTime() >= effectiveAt.getTime()) {
    if (planService.isFreePlan(change.planId)) return result('active', change.planId, { periodEnded: true, reason: 'scheduled_change' });
    const termEnd = toDate(change.termEnd);
    if (termEnd && at.getTime() < termEnd.getTime()) {
      return result('active', change.planId, { periodEnded: true, reason: 'scheduled_change' });
    }
  }
  const graceEnd = sub.state === 'past_due' && toDate(sub.graceEndsAt)
    ? toDate(sub.graceEndsAt)
    : new Date((periodEnd ?? at).getTime() + Math.max(0, graceDays) * DAY_MS);
  if (at.getTime() < graceEnd.getTime()) {
    return result('past_due', planId, { inGrace: true, graceEndsAt: graceEnd, periodEnded: true, reason: 'grace' });
  }
  return result('restricted', planId, { graceEndsAt: graceEnd, periodEnded: true, reason: 'unpaid' });
}

function shapeSubscription(sub) {
  if (!sub) return null;
  return {
    id: String(sub._id),
    tenantId: sub.tenantId,
    planId: sub.planId,
    state: sub.state,
    trialEndsAt: sub.trialEndsAt ?? null,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceEndsAt: sub.graceEndsAt ?? null,
    canceledAt: sub.canceledAt ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
    paymentProvider: sub.paymentProvider ?? null,
    paymentReference: sub.paymentReference ?? null,
    previousPlanId: sub.previousPlanId ?? null,
    previousState: sub.previousState ?? null,
    stateChangedAt: sub.stateChangedAt ?? null,
    lastReconciledAt: sub.lastReconciledAt ?? null,
    billingInterval: sub.billingInterval ?? null,
    adminHold: sub.adminHold === true,
    scheduledChange: sub.scheduledChange
      ? {
          planId: sub.scheduledChange.planId,
          effectiveAt: sub.scheduledChange.effectiveAt ?? null,
          termEnd: sub.scheduledChange.termEnd ?? null,
          interval: sub.scheduledChange.interval ?? null,
          source: sub.scheduledChange.source ?? null,
        }
      : null,
    createdAt: sub.createdAt ?? null,
    updatedAt: sub.updatedAt ?? null,
  };
}

function ensureTenantExists(tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
}

/** Create the canonical subscription for a tenant. Idempotent: a
 *  re-call on an existing subscription returns the existing row. */
export async function createForTenant({
  tenantId,
  planId,
  state = 'active',
  trialDays = null,
  actor = null,
  by = null,
  reason = null,
  paymentProvider = null,
  paymentReference = null,
} = {}) {
  ensureTenantExists(tenantId);
  if (!planId) throw ApiError.badRequest('planId is required');

  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (existing) return shapeSubscription(existing);

  assertTransition(null, state);

  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) {
    throw ApiError.notFound('Tenant not found');
  }

  const now = clock.now();
  const trialEndsAt =
    state === 'trialing' && trialDays && trialDays > 0
      ? new Date(now.getTime() + trialDays * 86400000)
      : null;
  if (state === 'trialing' && !trialEndsAt) {
    // billing: a trial exists only when the plan defines trialDays.
    throw ApiError.badRequest('A trial needs a positive trialDays');
  }
  const window = defaultPeriodWindow(now);

  const created = await subscriptionRepository.upsertForTenant(
    tenantId,
    {
      planId,
      state,
      trialEndsAt,
      currentPeriodStart: window.start,
      currentPeriodEnd: trialEndsAt ?? window.end,
      graceEndsAt: state === 'past_due' ? new Date(now.getTime() + 7 * 86400000) : null,
      canceledAt: state === 'canceled' ? now : null,
      cancelAtPeriodEnd: false,
      paymentProvider,
      paymentReference,
      previousPlanId: null,
      previousState: null,
      stateChangedAt: now,
    },
    { by: asActor(by) },
  );

  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.created',
    fromState: null,
    toState: state,
    fromPlanId: null,
    toPlanId: planId,
    reason: reason ?? null,
    actor: actor ?? actorOf(by),
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.created',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(created._id) },
    tenantId,
    after: { planId, state },
  });
  return shapeSubscription(created);
}

export async function getForTenant(tenantId) {
  ensureTenantExists(tenantId);
  const sub = await subscriptionRepository.findByTenantId(tenantId);
  return shapeSubscription(sub);
}

export async function changePlan({
  tenantId,
  planId,
  actor = null,
  by = null,
  reason = null,
  termEnd = null,
  historyType = 'subscription.plan_changed',
}) {
  ensureTenantExists(tenantId);
  if (!planId) throw ApiError.badRequest('planId is required');
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (existing.planId === planId && !termEnd) {
    // Idempotent re-application of the same plan.
    return shapeSubscription(existing);
  }
  const now = clock.now();
  const window = defaultPeriodWindow(now);
  const end = termEnd ? toDate(termEnd) : window.end;
  if (!end || end.getTime() <= now.getTime()) throw ApiError.badRequest('termEnd must be in the future');
  const updated = await subscriptionRepository.update(
    existing._id,
    {
      planId,
      previousPlanId: existing.planId,
      currentPeriodStart: window.start,
      currentPeriodEnd: end,
      stateChangedAt: now,
      // billing: an explicit plan change supersedes a queued downgrade.
      scheduledChange: null,
    },
    { by: asActor(by) },
  );
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: historyType,
    fromState: updated.state,
    toState: updated.state,
    fromPlanId: existing.planId,
    toPlanId: planId,
    reason: reason ?? null,
    actor: actor ?? actorOf(by),
    metadata: termEnd ? { termEnd: end } : {},
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.plan_changed',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { planId: existing.planId, currentPeriodEnd: existing.currentPeriodEnd },
    after: { planId, currentPeriodEnd: end },
    metadata: reason ? { reason } : undefined,
  });
  return shapeSubscription(updated);
}

export async function cancel({
  tenantId,
  actor = null,
  by = null,
  immediate = false,
  reason = null,
}) {
  ensureTenantExists(tenantId);
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (existing.state === 'canceled') {
    return shapeSubscription(existing);
  }
  if (existing.state === 'expired' || existing.state === 'restricted') {
    throw ApiError.conflict(`Cannot cancel a subscription in state "${existing.state}"`);
  }
  if (planService.isFreePlan(existing.planId)) {
    // billing: the free plan is perpetual; there is no term to cancel.
    throw ApiError.conflict('The free plan has no paid term to cancel');
  }
  if (existing.scheduledChange?.source === 'payment') {
    // billing: a paid, queued term would be lost; an admin must refund it.
    throw ApiError.conflict('A prepaid term is queued after this one; contact support to cancel');
  }
  assertTransition(existing.state, 'canceled');
  const now = clock.now();
  let patch = {
    state: 'canceled',
    previousState: existing.state,
    canceledAt: now,
    cancelAtPeriodEnd: !immediate,
    stateChangedAt: now,
    scheduledChange: null,
  };
  if (immediate) {
    patch.currentPeriodEnd = now;
  }
  const updated = await subscriptionRepository.update(
    existing._id,
    patch,
    { by: asActor(by) },
  );
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.canceled',
    fromState: existing.state,
    toState: 'canceled',
    fromPlanId: existing.planId,
    toPlanId: existing.planId,
    reason: reason ?? null,
    actor: actor ?? actorOf(by),
    metadata: { immediate: !!immediate },
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.canceled',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { state: existing.state },
    after: { state: 'canceled', immediate: !!immediate },
  });
  return shapeSubscription(updated);
}

/**
 * Undo a cancellation while the prepaid term is still running. billing:
 * the period is kept as bought (reactivation never extends access); a term
 * that already ended needs a new payment or an admin.
 */
export async function reactivate({
  tenantId,
  planId = null,
  actor = null,
  by = null,
  reason = null,
}) {
  ensureTenantExists(tenantId);
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (existing.state === 'active') {
    return shapeSubscription(existing);
  }
  const target = planId ?? existing.planId;
  assertTransition(existing.state, 'active');
  const now = clock.now();
  const periodEnd = toDate(existing.currentPeriodEnd);
  if (!periodEnd || periodEnd.getTime() <= now.getTime()) {
    throw ApiError.conflict('The prepaid term has ended; purchase a new term to continue');
  }
  const updated = await subscriptionRepository.update(
    existing._id,
    {
      state: 'active',
      planId: target,
      previousState: existing.state,
      previousPlanId: existing.planId === target ? existing.previousPlanId : existing.planId,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      graceEndsAt: null,
      stateChangedAt: now,
    },
    { by: asActor(by) },
  );
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.reactivated',
    fromState: existing.state,
    toState: 'active',
    fromPlanId: existing.planId,
    toPlanId: target,
    reason: reason ?? null,
    actor: actor ?? actorOf(by),
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.reactivated',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { state: existing.state, planId: existing.planId },
    after: { state: 'active', planId: target },
  });
  return shapeSubscription(updated);
}

export async function setState({
  tenantId,
  state,
  graceEndsAt = null,
  periodEnd = null,
  actor = null,
  by = null,
  reason,
  system = false,
}) {
  ensureTenantExists(tenantId);
  if (!state) throw ApiError.badRequest('state is required');
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for an administrative state change');
  }
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  assertTransition(existing.state, state);
  const now = clock.now();
  const patch = {
    state,
    previousState: existing.state,
    graceEndsAt: state === 'past_due' ? graceEndsAt ?? new Date(now.getTime() + 7 * 86400000) : null,
    stateChangedAt: now,
  };
  // billing: an administrative restriction is a hold money events must not
  // lift; the lifecycle job's own restriction (`system`) is not.
  if (state === 'restricted') patch.adminHold = !system;
  else if (!system) patch.adminHold = false;
  if (state === 'active' || state === 'trialing') {
    const end = toDate(periodEnd);
    const current = toDate(existing.currentPeriodEnd);
    if (end) {
      if (end.getTime() <= now.getTime()) throw ApiError.badRequest('periodEnd must be in the future');
      patch.currentPeriodEnd = end;
    } else if (!current || current.getTime() <= now.getTime()) {
      // Re-activating a lapsed term without an end date grants the default
      // window, recorded in the history row below.
      const window = defaultPeriodWindow(now);
      patch.currentPeriodStart = window.start;
      patch.currentPeriodEnd = window.end;
    }
  }
  const updated = await subscriptionRepository.update(existing._id, patch, { by: asActor(by) });
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.state_changed',
    fromState: existing.state,
    toState: state,
    fromPlanId: existing.planId,
    toPlanId: existing.planId,
    reason,
    actor: actor ?? actorOf(by),
    metadata: patch.currentPeriodEnd ? { currentPeriodEnd: patch.currentPeriodEnd } : {},
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.state_changed',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { state: existing.state },
    after: { state },
    metadata: { reason },
  });
  return shapeSubscription(updated);
}

/* ------------------------------------------------------------------------ */
/* billing (roadmap 3.1): provisioning, prepaid terms, lifecycle             */
/* ------------------------------------------------------------------------ */

const SYSTEM_LIFECYCLE_ACTOR = Object.freeze({ type: 'system', id: 'billing-lifecycle' });

/**
 * Default provisioning (finding bil.09). Returns the tenant's subscription,
 * creating it when missing: a trial of the tenant record's plan when that
 * plan defines `trialDays`, otherwise the free plan. Never reads a plan from
 * the request. Idempotent (unique tenantId).
 */
export async function ensureForTenant({ tenantId, actor = null, by = null, reason = 'Default provisioning' } = {}) {
  ensureTenantExists(tenantId);
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (existing) return shapeSubscription(existing);
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  const requested = tenant.planId ? await planService.getActiveByCode(tenant.planId) : null;
  const trialDays = requested?.data?.trialDays;
  const trial = requested && !planService.isFreePlan(requested) && Number.isInteger(trialDays) && trialDays > 0;
  return createForTenant({
    tenantId,
    planId: trial ? requested.code : DEFAULT_PLAN_CODE,
    state: trial ? 'trialing' : 'active',
    trialDays: trial ? trialDays : null,
    actor: actor ?? actorOf(by),
    by,
    reason: trial ? `${reason} (trial of "${requested.code}")` : reason,
  });
}

/** Write a patch only if the row has not moved since `existing` was read. */
async function casUpdate(existing, patch, by) {
  const updated = await subscriptionRepository.update(existing._id, patch, {
    by: asActor(by),
    expect: { updatedAt: existing.updatedAt },
  });
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  return updated;
}

/**
 * Apply one prepaid term bought by a verified, captured payment. Only the
 * billing lifecycle service calls this (after provider confirmation).
 * Idempotent on `transactionId` (`lastTransactionId`).
 *
 *   - no subscription: create it on the plan for the term
 *   - same plan, term still running: renew (extend from the period end)
 *   - higher tier, or the term already lapsed: start the new term now
 *   - lower tier (or another plan of the same tier) while a term runs:
 *     queue it to start at the period end (scheduled downgrade)
 *
 * Upgrades do not prorate the unused part of the current term (documented
 * limitation of the prepaid model).
 *
 * @returns {Promise<{ subscription: object, mode: string, idempotent: boolean }>}
 */
export async function applyPaidTerm({
  tenantId,
  planId,
  interval = 'month',
  termMonths = 1,
  transactionId,
  providerRef = null,
  paymentId = null,
  actor = null,
  now = clock.now(),
} = {}) {
  ensureTenantExists(tenantId);
  if (!planId) throw ApiError.badRequest('planId is required');
  if (!transactionId) throw ApiError.badRequest('transactionId is required');
  if (!Number.isInteger(termMonths) || termMonths < 1) throw ApiError.badRequest('termMonths must be a positive integer');
  const who = actor ?? { type: 'system', id: 'billing' };
  const txnId = String(transactionId);

  let existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) {
    // Provision the default first so the term is applied by the same rules.
    const created = await ensureForTenant({ tenantId, actor: who, by: who.id, reason: 'Provisioning before a purchase' });
    existing = await subscriptionRepository.findById(created.id);
  }
  if (existing.lastTransactionId === txnId) {
    return { subscription: shapeSubscription(existing), mode: 'already_applied', idempotent: true };
  }
  if (existing.state === 'restricted' && existing.adminHold === true) {
    throw ApiError.conflict('Subscription is under an administrative hold; provider events cannot activate it');
  }

  const { plan: currentPlan } = await planService.resolveByCode(existing.planId);
  const { plan: targetPlan } = await planService.resolveByCode(planId);
  const access = computeAccess(existing, { now, graceDays: graceDaysFor(currentPlan) });
  const running = !planService.isFreePlan(existing.planId)
    && ['active', 'trialing', 'canceled'].includes(access.state)
    && access.planId === existing.planId;
  const periodEnd = toDate(existing.currentPeriodEnd) ?? now;
  const base = {
    lastTransactionId: txnId,
    paymentProvider: 'razorpay',
    paymentReference: providerRef,
    stateChangedAt: now,
  };

  let mode;
  let patch;
  let replacedTransactionId = null;
  if (running && existing.planId === planId) {
    mode = existing.state === 'trialing' ? 'trial_converted' : 'renewed';
    const from = new Date(Math.max(now.getTime(), periodEnd.getTime()));
    const newEnd = addMonths(from, termMonths);
    // A renewal withdraws a queued move to free; a queued prepaid term moves
    // back by the same amount so it still starts when this term ends.
    const queued = existing.scheduledChange;
    let scheduledChange = null;
    if (queued?.source === 'payment') {
      const shift = newEnd.getTime() - periodEnd.getTime();
      scheduledChange = {
        ...queued,
        effectiveAt: newEnd,
        termEnd: queued.termEnd ? new Date(new Date(queued.termEnd).getTime() + shift) : null,
      };
    }
    patch = {
      ...base,
      state: 'active',
      previousState: existing.state,
      currentPeriodEnd: newEnd,
      scheduledChange,
      billingInterval: interval,
      graceEndsAt: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      trialEndsAt: existing.state === 'trialing' ? existing.trialEndsAt : existing.trialEndsAt ?? null,
    };
  } else if (running && planService.tierOf(targetPlan) <= planService.tierOf(currentPlan)) {
    mode = 'scheduled';
    const queued = existing.scheduledChange;
    const sameQueued = queued?.source === 'payment' && queued.planId === planId && queued.termEnd;
    const effectiveAt = sameQueued ? toDate(queued.effectiveAt) : periodEnd;
    const termStart = sameQueued ? toDate(queued.termEnd) : periodEnd;
    patch = {
      ...base,
      scheduledChange: {
        planId,
        effectiveAt,
        termEnd: addMonths(termStart, termMonths),
        interval,
        transactionId: txnId,
        source: 'payment',
        requestedBy: who.id ?? null,
        requestedAt: now,
      },
    };
    if (queued && !sameQueued && queued.source === 'payment') {
      // A different prepaid term was already queued: keep a trace so an
      // operator can refund it (checkout refuses this case up front).
      replacedTransactionId = queued.transactionId;
    }
  } else {
    if (running) mode = 'upgraded';
    else mode = planService.isFreePlan(existing.planId) ? 'activated' : 'reactivated';
    patch = {
      ...base,
      planId,
      previousPlanId: existing.planId === planId ? existing.previousPlanId : existing.planId,
      state: 'active',
      previousState: existing.state,
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, termMonths),
      billingInterval: interval,
      graceEndsAt: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
    };
  }
  if (patch.state && patch.state !== existing.state) assertTransition(existing.state, patch.state);

  const updated = await subscriptionRepository.update(existing._id, patch, {
    by: who.id,
    expect: { updatedAt: existing.updatedAt, lastTransactionId: existing.lastTransactionId ?? null },
  });
  if (!updated) {
    const fresh = await subscriptionRepository.findByTenantId(tenantId);
    if (fresh?.lastTransactionId === txnId) {
      return { subscription: shapeSubscription(fresh), mode: 'already_applied', idempotent: true };
    }
    throw ApiError.conflict('Subscription changed concurrently; please retry');
  }
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.payment_captured',
    fromState: existing.state,
    toState: updated.state,
    fromPlanId: existing.planId,
    toPlanId: mode === 'scheduled' ? existing.planId : planId,
    reason: `Prepaid ${interval} term of "${planId}" ${mode} (${providerRef ?? txnId})`,
    actor: who,
    metadata: {
      transactionId: txnId,
      providerRef,
      paymentId,
      interval,
      termMonths,
      mode,
      currentPeriodEnd: updated.currentPeriodEnd,
      ...(mode === 'scheduled' ? { scheduledPlanId: planId, effectiveAt: updated.scheduledChange?.effectiveAt } : {}),
      ...(replacedTransactionId ? { replacedTransactionId } : {}),
    },
  });
  await auditEmit({
    actor: who,
    action: 'subscription.payment_captured',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { planId: existing.planId, state: existing.state, currentPeriodEnd: existing.currentPeriodEnd },
    after: { planId: updated.planId, state: updated.state, currentPeriodEnd: updated.currentPeriodEnd, mode },
  });
  return { subscription: shapeSubscription(updated), mode, idempotent: false };
}

/**
 * Queue a plan change for the end of the current term (finding: downgrades
 * apply at period end). A term that already ended, or the free plan, is
 * switched at once. Workspace callers may only target the free plan; paid
 * lower tiers are bought through checkout (queued by `applyPaidTerm`).
 */
export async function scheduleChange({ tenantId, planId, actor = null, by = null, reason = null, source = 'workspace', now = clock.now() } = {}) {
  ensureTenantExists(tenantId);
  if (!planId) throw ApiError.badRequest('planId is required');
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (existing.planId === planId) return clearScheduledChange({ tenantId, actor, by, reason });
  if (existing.state === 'restricted' && existing.adminHold === true) {
    throw ApiError.conflict('Subscription is under an administrative hold; contact support');
  }
  const { plan: currentPlan } = await planService.resolveByCode(existing.planId);
  const access = computeAccess(existing, { now, graceDays: graceDaysFor(currentPlan) });
  const termRunning = !planService.isFreePlan(existing.planId)
    && ['active', 'trialing', 'canceled'].includes(access.state)
    && access.planId === existing.planId;
  const who = actor ?? actorOf(by);

  if (!termRunning) {
    // The paid term is over (or this is the free plan): switch now.
    const window = { start: now, end: addMonths(now, 1) };
    if (existing.state !== 'active') assertTransition(existing.state, 'active');
    const updated = await casUpdate(existing, {
      planId,
      previousPlanId: existing.planId,
      state: 'active',
      previousState: existing.state,
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
      graceEndsAt: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      billingInterval: null,
      stateChangedAt: now,
    }, by);
    await subscriptionRepository.appendHistory(tenantId, {
      type: 'subscription.plan_changed',
      fromState: existing.state,
      toState: 'active',
      fromPlanId: existing.planId,
      toPlanId: planId,
      reason: reason ?? 'Plan changed after the paid term ended',
      actor: who,
      metadata: { immediate: true, source },
    });
    await auditEmit({
      actor: who,
      action: 'subscription.plan_changed',
      module: 'iam.subscriptions',
      resource: { type: 'subscription', id: String(updated._id) },
      tenantId,
      before: { planId: existing.planId, state: existing.state },
      after: { planId, state: 'active' },
    });
    return shapeSubscription(updated);
  }

  if (existing.scheduledChange?.source === 'payment') {
    throw ApiError.conflict('A prepaid term is already queued for the end of this term; contact support to change it');
  }
  const updated = await casUpdate(existing, {
    scheduledChange: {
      planId,
      effectiveAt: toDate(existing.currentPeriodEnd),
      termEnd: null,
      interval: null,
      transactionId: null,
      source,
      requestedBy: who.id ?? null,
      requestedAt: now,
    },
  }, by);
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.plan_changed',
    fromState: existing.state,
    toState: existing.state,
    fromPlanId: existing.planId,
    toPlanId: existing.planId,
    reason: reason ?? `Change to "${planId}" scheduled for the end of the term`,
    actor: who,
    metadata: { scheduledPlanId: planId, effectiveAt: existing.currentPeriodEnd, source },
  });
  await auditEmit({
    actor: who,
    action: 'subscription.change_scheduled',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    after: { scheduledPlanId: planId, effectiveAt: existing.currentPeriodEnd },
  });
  return shapeSubscription(updated);
}

/** Drop a queued workspace downgrade (a queued paid term is kept). */
export async function clearScheduledChange({ tenantId, actor = null, by = null, reason = null } = {}) {
  ensureTenantExists(tenantId);
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (!existing.scheduledChange) return shapeSubscription(existing);
  if (existing.scheduledChange.source === 'payment') {
    throw ApiError.conflict('A prepaid term is queued; contact support to change it');
  }
  const updated = await casUpdate(existing, { scheduledChange: null }, by);
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.plan_changed',
    fromState: existing.state,
    toState: existing.state,
    fromPlanId: existing.planId,
    toPlanId: existing.planId,
    reason: reason ?? 'Scheduled plan change withdrawn',
    actor: actor ?? actorOf(by),
    metadata: { withdrawnPlanId: existing.scheduledChange.planId },
  });
  return shapeSubscription(updated);
}

/**
 * One lifecycle step for a tenant (the lifecycle job's unit of work):
 * persist what `computeAccess` already enforces. Safe to repeat: it acts
 * only when the stored state lags the computed one, and every write is a
 * compare-and-set.
 *
 * @returns {Promise<{ action: string, subscription: object|null }>}
 */
export async function advanceLifecycle({ tenantId, now = clock.now() } = {}) {
  ensureTenantExists(tenantId);
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) return { action: 'none', subscription: null };
  const { plan } = await planService.resolveByCode(existing.planId);
  const access = computeAccess(existing, { now, graceDays: graceDaysFor(plan) });
  const periodEnd = toDate(existing.currentPeriodEnd);
  const who = SYSTEM_LIFECYCLE_ACTOR;
  const history = (entry) => subscriptionRepository.appendHistory(tenantId, { actor: who, ...entry });

  if (planService.isFreePlan(existing.planId)) {
    if (periodEnd && periodEnd.getTime() <= now.getTime() && existing.state !== 'restricted') {
      // The free plan is perpetual: roll its bookkeeping period forward.
      const updated = await casUpdate(existing, {
        state: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: addMonths(now, 1),
        scheduledChange: null,
      }, who.id);
      return { action: 'rolled', subscription: shapeSubscription(updated) };
    }
    return { action: 'none', subscription: shapeSubscription(existing) };
  }

  if (existing.state === 'trialing' && access.reason === 'trial_ended') {
    const updated = await casUpdate(existing, {
      planId: DEFAULT_PLAN_CODE,
      previousPlanId: existing.planId,
      state: 'active',
      previousState: 'trialing',
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, 1),
      scheduledChange: null,
      billingInterval: null,
      stateChangedAt: now,
    }, who.id);
    await history({
      type: 'subscription.plan_changed', fromState: 'trialing', toState: 'active',
      fromPlanId: existing.planId, toPlanId: DEFAULT_PLAN_CODE, reason: 'Trial ended without a purchase; moved to the free plan',
    });
    return { action: 'trial_ended', subscription: shapeSubscription(updated) };
  }

  if (existing.state === 'active' && access.reason === 'scheduled_change') {
    const change = existing.scheduledChange;
    const toFree = planService.isFreePlan(change.planId);
    const effectiveAt = toDate(change.effectiveAt) ?? now;
    const updated = await casUpdate(existing, {
      planId: change.planId,
      previousPlanId: existing.planId,
      state: 'active',
      currentPeriodStart: toFree ? now : effectiveAt,
      currentPeriodEnd: toFree ? addMonths(now, 1) : toDate(change.termEnd),
      billingInterval: toFree ? null : change.interval ?? existing.billingInterval,
      lastTransactionId: change.transactionId ?? existing.lastTransactionId ?? null,
      scheduledChange: null,
      graceEndsAt: null,
      stateChangedAt: now,
    }, who.id);
    await history({
      type: 'subscription.plan_changed', fromState: 'active', toState: 'active',
      fromPlanId: existing.planId, toPlanId: change.planId, reason: 'Scheduled plan change applied at the end of the term',
      metadata: { source: change.source ?? null, transactionId: change.transactionId ?? null },
    });
    return { action: 'scheduled_applied', subscription: shapeSubscription(updated) };
  }

  const target = access.state;
  if (target === existing.state) return { action: 'none', subscription: shapeSubscription(existing) };
  if (!['past_due', 'restricted', 'expired'].includes(target)) {
    return { action: 'none', subscription: shapeSubscription(existing) };
  }
  assertTransition(existing.state, target);
  const patch = { state: target, previousState: existing.state, stateChangedAt: now };
  if (target === 'past_due') patch.graceEndsAt = access.graceEndsAt;
  if (target === 'restricted') patch.adminHold = false;
  const updated = await casUpdate(existing, patch, who.id);
  const reasons = {
    past_due: 'Prepaid term ended without renewal; grace period started',
    restricted: 'Grace period ended without renewal; workspace restricted',
    expired: 'Canceled subscription reached the end of its term',
  };
  await history({
    type: 'subscription.state_changed', fromState: existing.state, toState: target,
    fromPlanId: existing.planId, toPlanId: existing.planId, reason: reasons[target],
    metadata: target === 'past_due' ? { graceEndsAt: access.graceEndsAt } : {},
  });
  await auditEmit({
    actor: who,
    action: 'subscription.state_changed',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { state: existing.state },
    after: { state: target },
    metadata: { reason: reasons[target] },
  });
  return { action: target, subscription: shapeSubscription(updated) };
}

export async function list({ page = 1, limit = 20, filter = {} } = {}) {
  const result = await subscriptionRepository.list({ page, limit, filter });
  return { ...result, docs: result.docs.map(shapeSubscription) };
}

export async function listForTenant(tenantId, opts = {}) {
  return subscriptionRepository.listHistory(tenantId, opts);
}

/**
 * Backfill / migration helper: ensure every existing tenant has a
 * subscription row. Reads `tenant.planId`; if the plan catalogue has
 * it, the subscription is created `active`; if not, it is created on
 * the safe-fallback plan and a `subscription.migrated` event is
 * recorded with the previous `planId`. Idempotent.
 *
 * @param {Object} opts
 * @param {(tenantId:string, planId:string|null) => Promise<boolean>} opts.planExists
 *        injected to avoid a circular import; the entitlement service
 *        passes `planService.getActiveByCode` here.
 * @param {string} [opts.fallbackPlanId]
 * @param {string} [opts.by]
 */
export async function backfillTenants({ tenants, planExists, fallbackPlanId, by = 'system' } = {}) {
  if (!Array.isArray(tenants)) return { processed: 0, migrated: 0 };
  let processed = 0;
  let migrated = 0;
  for (const tenant of tenants) {
    processed += 1;
    const tenantId = String(tenant._id ?? tenant.id);
    if (!tenantId) continue;
    const existing = await subscriptionRepository.findByTenantId(tenantId);
    if (existing) continue;
    const requested = tenant.planId ?? null;
    let planId = requested;
    let migratedFlag = false;
    if (!planId || !(await planExists(planId))) {
      planId = fallbackPlanId;
      migratedFlag = true;
    }
    const sub = await createForTenant({
      tenantId,
      planId,
      state: 'active',
      actor: { type: 'system', id: 'migration' },
      by,
      reason: migratedFlag ? 'Initial backfill from tenant.planId' : 'Initial backfill',
    });
    if (migratedFlag) {
      migrated += 1;
      await subscriptionRepository.appendHistory(tenantId, {
        type: 'subscription.migrated',
        fromState: null,
        toState: 'active',
        fromPlanId: requested,
        toPlanId: planId,
        reason: 'Plan not found in catalogue; using safe fallback',
        actor: { type: 'system', id: 'migration' },
      });
    }
  }
  return { processed, migrated };
}

export default {
  assertTransition,
  computeAccess,
  addMonths,
  graceDaysFor,
  ensureForTenant,
  applyPaidTerm,
  scheduleChange,
  clearScheduledChange,
  advanceLifecycle,
  createForTenant,
  getForTenant,
  changePlan,
  cancel,
  reactivate,
  setState,
  list,
  listForTenant,
  backfillTenants,
  _meta: { module: 'iam.subscriptions' },
};
