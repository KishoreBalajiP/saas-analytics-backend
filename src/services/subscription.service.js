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
    trialing: new Set(['active', 'canceled', 'expired', 'restricted']),
    active: new Set(['past_due', 'canceled', 'restricted']),
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

function defaultPeriodWindow(now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 30);
  return { start, end };
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

  const now = new Date();
  const trialEndsAt =
    state === 'trialing' && trialDays && trialDays > 0
      ? new Date(now.getTime() + trialDays * 86400000)
      : null;
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
}) {
  ensureTenantExists(tenantId);
  if (!planId) throw ApiError.badRequest('planId is required');
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  if (existing.planId === planId) {
    // Idempotent re-application of the same plan.
    return shapeSubscription(existing);
  }
  const now = new Date();
  const window = defaultPeriodWindow(now);
  const updated = await subscriptionRepository.update(
    existing._id,
    {
      planId,
      previousPlanId: existing.planId,
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
      stateChangedAt: now,
    },
    { by: asActor(by) },
  );
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.plan_changed',
    fromState: updated.state,
    toState: updated.state,
    fromPlanId: existing.planId,
    toPlanId: planId,
    reason: reason ?? null,
    actor: actor ?? actorOf(by),
  });
  await auditEmit({
    actor: actor ?? actorOf(by),
    action: 'subscription.plan_changed',
    module: 'iam.subscriptions',
    resource: { type: 'subscription', id: String(updated._id) },
    tenantId,
    before: { planId: existing.planId },
    after: { planId },
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
  assertTransition(existing.state, 'canceled');
  const now = new Date();
  let patch = {
    state: 'canceled',
    previousState: existing.state,
    canceledAt: now,
    cancelAtPeriodEnd: !immediate,
    stateChangedAt: now,
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
  const now = new Date();
  const window = defaultPeriodWindow(now);
  const updated = await subscriptionRepository.update(
    existing._id,
    {
      state: 'active',
      planId: target,
      previousState: existing.state,
      previousPlanId: existing.planId === target ? existing.previousPlanId : existing.planId,
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
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
  actor = null,
  by = null,
  reason,
}) {
  ensureTenantExists(tenantId);
  if (!state) throw ApiError.badRequest('state is required');
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for an administrative state change');
  }
  const existing = await subscriptionRepository.findByTenantId(tenantId);
  if (!existing) throw ApiError.notFound('No subscription for this tenant');
  assertTransition(existing.state, state);
  const now = new Date();
  const updated = await subscriptionRepository.update(
    existing._id,
    {
      state,
      previousState: existing.state,
      graceEndsAt: state === 'past_due' ? graceEndsAt ?? new Date(now.getTime() + 7 * 86400000) : null,
      stateChangedAt: now,
    },
    { by: asActor(by) },
  );
  if (!updated) throw ApiError.conflict('Subscription changed concurrently; please retry');
  await subscriptionRepository.appendHistory(tenantId, {
    type: 'subscription.state_changed',
    fromState: existing.state,
    toState: state,
    fromPlanId: existing.planId,
    toPlanId: existing.planId,
    reason,
    actor: actor ?? actorOf(by),
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
