/**
 * Usage service (Phase 6; roadmap 1.3 - quotas count resources).
 *
 * PURPOSE
 *   Front door for usage accounting. Resource quotas (connectors,
 *   dashboards, reports, scheduled reports, alerts, members, stored rows)
 *   count resources that exist: they go up when one is created and down
 *   when one is deleted. Metered quotas (`apiCallsPerDay`) count events in
 *   a period that resets (the UTC day). Reconciliation recounts the real
 *   resources and corrects drifted counters.
 *
 * RESPONSIBILITY
 *   - checkAndConsume({ tenantId, metric, requested })  atomic enforce + record
 *   - withQuota({ tenantId, metric }, fn)              consume, run, release on failure
 *   - release({ tenantId, metric, requested })          delete counterpart, never < 0
 *   - assertCapacity({ tenantId, metric, requested })   non-consuming pre-check
 *   - meterApiCall({ tenantId })                        one external API call
 *   - reserve({ tenantId, metric, key, requested })     consume now for queued work,
 *                                                      recorded in the reservation ledger
 *   - cancelReservation({ tenantId, metric, key })      give back what a reservation has left
 *   - createStoredRowsSink({ tenantId, connectorId, upsert, reservationKey })
 *                                                      meters rows a sync really adds
 *                                                      (draws on a request-time
 *                                                      reservation; settle() returns the rest)
 *   - adjustStoredRows({ tenantId, delta })             rows added/removed outside a sync
 *   - incrementCumulative({ tenantId, metric, period }) raw metered increment
 *   - reconcile({ tenantId, dryRun })                   recount one tenant
 *   - reconcileAll({ dryRun })                          recount every tenant
 *
 * CONCURRENCY
 *   - Hard limits use `incrementWithinLimit`, a single conditional upsert:
 *     the counter is only incremented while it has room, so N concurrent
 *     creates against a limit of K succeed exactly K times and the counter
 *     never passes the limit, not even transiently.
 *   - Soft limits increment unconditionally and report a warning: a soft
 *     limit never refuses (bil.07).
 *   - Releases decrement atomically and clamp at zero.
 *   - Reconciliation writes with compare-and-set and skips counters that
 *     changed within the settle window (an in-flight create bumps the
 *     counter before its document exists).
 *   - Capacity reserved at request time for queued work (a webhook
 *     delivery's storedRows) is recorded in the `UsageReservation` ledger.
 *     The worker draws from the ledger (so a retry or replay never draws
 *     the same capacity twice), and reconciliation counts open reservations
 *     as in use instead of erasing them while the message waits.
 *
 * ERRORS
 *   Every hard-limit refusal is `QUOTA_EXCEEDED` built by
 *   `entitlementService.quotaExceededError` (409 for resource counts, 429
 *   for metered metrics) carrying metric, limit, current and reset time.
 *   A write-blocked subscription (expired/restricted) answers 403
 *   `SUBSCRIPTION_WRITE_BLOCKED` for writes; metered reads still count.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import { ERROR_CODES } from '../config/constants.js';
import logger from '../utils/logger.js';
import entitlementService from './entitlement.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import usageCounterRepository from '../repositories/usageCounter.repository.js';
import usageSourceRepository from '../repositories/usageSource.repository.js';
import usageReservationRepository from '../repositories/usageReservation.repository.js';
import { USAGE_METRICS, periodOf, periodKeyFor, periodEndFor } from '../models/UsageCounter.js';

/** `current` metrics that reconciliation can recount from real resources. */
export const RECONCILED_METRICS = Object.freeze([
  'members',
  'connectors',
  'dashboards',
  'reports',
  'scheduledReports',
  'alerts',
  'storedRows',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function assertMetric(metric) {
  if (!metric) throw ApiError.badRequest('metric is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw ApiError.badRequest(`Unknown usage metric "${metric}"`);
  }
}

function writeBlockedError(state) {
  return new ApiError(
    403,
    `Subscription state "${state}" blocks writes; restore or upgrade to continue.`,
    { code: ERROR_CODES.SUBSCRIPTION_WRITE_BLOCKED },
  );
}

/** Metered rows expire after the retention window that follows their period. */
function meteredExpiry(metric, now) {
  const end = periodEndFor(metric, now);
  return end ? new Date(end.getTime() + env.usage.meteredRetentionDays * DAY_MS) : null;
}

/**
 * Unconditional increment (no limit or a soft limit). Resource counts go
 * through the audited path; metered per-period rows are written silently
 * and carry their expiry.
 */
function incrementUnbounded({ tenantId, metric, period, delta, by, kind, expiresAt }) {
  if (period === 'current') {
    return usageCounterRepository.incrementOrCreate({ tenantId, metric, period, delta, by, kind });
  }
  return usageCounterRepository.incrementSilently({ tenantId, metric, period, delta, by, kind, expiresAt });
}

/**
 * Enforce and record usage atomically. Returns the new counter value.
 * Throws `QUOTA_EXCEEDED` when a hard limit has no room; a soft limit
 * allows the action and returns `soft: true` once the limit is passed.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.metric
 * @param {number} [opts.requested=1]
 * @param {string|null} [opts.by]
 * @param {Date} [opts.now] - clock for metered periods (tests).
 */
export async function checkAndConsume({ tenantId, metric, requested = 1, by = null, now = new Date() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  assertMetric(metric);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw ApiError.badRequest('requested must be a positive integer');
  }
  const ent = await entitlementService.resolveEffective(tenantId);
  if (ent.writeBlocked) throw writeBlockedError(ent.state);

  const period = periodKeyFor(metric, now);
  const kind = period === 'current' ? 'current' : 'cumulative';
  const expiresAt = meteredExpiry(metric, now);
  const limit = ent.limits[metric] ?? null;

  if (!limit) {
    const inc = await incrementUnbounded({ tenantId, metric, period, delta: requested, by, kind, expiresAt });
    return { allowed: true, soft: false, ungoverned: true, metric, value: inc.value };
  }

  if (limit.hard) {
    const res = await usageCounterRepository.incrementWithinLimit({
      tenantId, metric, period, delta: requested, max: limit.max, by, kind, expiresAt,
    });
    if (!res.ok) {
      throw entitlementService.quotaExceededError({
        metric,
        limit: limit.max,
        current: res.value,
        requested,
        period,
        resetsAt: periodEndFor(metric, now),
        planCode: ent.plan.code,
      });
    }
    return {
      allowed: true,
      soft: false,
      hard: true,
      metric,
      limit: limit.max,
      current: res.value - requested,
      requested,
      value: res.value,
    };
  }

  // Soft limit: never refuse; flag the warning once the limit is passed.
  const inc = await incrementUnbounded({ tenantId, metric, period, delta: requested, by, kind, expiresAt });
  return {
    allowed: true,
    soft: inc.value > limit.max,
    hard: false,
    metric,
    limit: limit.max,
    current: inc.value - requested,
    requested,
    value: inc.value,
  };
}

/**
 * Give back resource capacity (delete counterpart). Clamped at zero and
 * never throws, so a counter problem can never block a delete. Metered
 * metrics are not released (the calls happened).
 */
export async function release({ tenantId, metric, requested = 1, by = null } = {}) {
  if (!tenantId) return { value: 0 };
  if (!USAGE_METRICS.includes(metric)) return { value: 0 };
  if (periodOf(metric) !== 'current') return { value: 0 };
  if (!Number.isInteger(requested) || requested <= 0) {
    // Nothing (or nothing sensible) to give back: never guess an amount.
    if (requested !== 0) logger.warn({ tenantId: String(tenantId), metric, requested }, 'usage release ignored: invalid amount');
    return { value: 0 };
  }
  try {
    return await usageCounterRepository.decrementClamped({ tenantId, metric, period: 'current', delta: requested, by });
  } catch (err) {
    logger.warn({ err: { message: err?.message }, tenantId: String(tenantId), metric }, 'usage release failed');
    return { value: 0, error: err?.message ?? 'unknown' };
  }
}

/**
 * Consume quota for one or more metrics, run `fn`, and give the quota back
 * if `fn` throws, so a failed create never leaks capacity. Metrics are
 * consumed in order; if a later one is refused, the earlier ones are
 * released before the error propagates.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string|string[]} opts.metric
 * @param {number} [opts.requested=1]
 * @param {string|null} [opts.by]
 * @param {Function} fn
 */
export async function withQuota({ tenantId, metric, requested = 1, by = null } = {}, fn) {
  const metrics = Array.isArray(metric) ? metric : [metric];
  const consumed = [];
  try {
    for (const m of metrics) {
      await checkAndConsume({ tenantId, metric: m, requested, by });
      consumed.push(m);
    }
    return await fn();
  } catch (err) {
    for (const m of consumed) await release({ tenantId, metric: m, requested, by });
    throw err;
  }
}

/**
 * Non-consuming capacity check for a hard limit: throws `QUOTA_EXCEEDED`
 * when `current + requested` would pass the limit, 403 when the
 * subscription blocks writes. `requested: 0` only refuses when the tenant
 * is already over its limit (e.g. after a downgrade).
 */
export async function assertCapacity({ tenantId, metric, requested = 1, now = new Date() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  assertMetric(metric);
  if (!Number.isInteger(requested) || requested < 0) {
    throw ApiError.badRequest('requested must be a non-negative integer');
  }
  const ent = await entitlementService.resolveEffective(tenantId);
  if (ent.writeBlocked) throw writeBlockedError(ent.state);
  const limit = ent.limits[metric] ?? null;
  const period = periodKeyFor(metric, now);
  const row = await usageCounterRepository.findOne(tenantId, metric, period);
  const current = row?.value ?? 0;
  if (limit?.hard && current + requested > limit.max) {
    throw entitlementService.quotaExceededError({
      metric,
      limit: limit.max,
      current,
      requested,
      period,
      resetsAt: periodEndFor(metric, now),
      planCode: ent.plan.code,
    });
  }
  return { allowed: true, metric, current, limit: limit?.max ?? null, hard: limit?.hard === true };
}

/**
 * Meter one authenticated external API call against `apiCallsPerDay` for
 * the UTC day containing `now`. Hard limits refuse with 429
 * `QUOTA_EXCEEDED` (including the reset time); soft limits only flag.
 * Reads stay allowed for write-blocked subscriptions.
 *
 * @returns {Promise<{ value: number, limit: number|null, remaining: number|null, resetsAt: string, soft: boolean }>}
 */
export async function meterApiCall({ tenantId, now = new Date() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const metric = 'apiCallsPerDay';
  const period = periodKeyFor(metric, now);
  const resetsAt = periodEndFor(metric, now);
  const expiresAt = meteredExpiry(metric, now);
  const ent = await entitlementService.resolveEffective(tenantId);
  const limit = ent.limits[metric] ?? null;

  if (limit?.hard) {
    const res = await usageCounterRepository.incrementWithinLimit({
      tenantId, metric, period, delta: 1, max: limit.max, kind: 'cumulative', expiresAt, silent: true,
    });
    if (!res.ok) {
      throw entitlementService.quotaExceededError({
        metric, limit: limit.max, current: res.value, requested: 1, period, resetsAt, planCode: ent.plan.code,
      });
    }
    return { value: res.value, limit: limit.max, remaining: Math.max(0, limit.max - res.value), resetsAt: resetsAt.toISOString(), soft: false };
  }

  const inc = await usageCounterRepository.incrementSilently({ tenantId, metric, period, delta: 1, kind: 'cumulative', expiresAt });
  return {
    value: inc.value,
    limit: limit?.max ?? null,
    remaining: limit ? Math.max(0, limit.max - inc.value) : null,
    resetsAt: resetsAt.toISOString(),
    soft: Boolean(limit && inc.value > limit.max),
  };
}

/**
 * Account rows added (`delta > 0`) or removed (`delta < 0`) outside the
 * metered sync sink, e.g. a replace-mode sync that deletes rows or an
 * ingestion path that persists rows itself. Additions are recorded
 * unconditionally (the rows already exist); removals clamp at zero.
 */
export async function adjustStoredRows({ tenantId, delta, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!Number.isInteger(delta)) throw ApiError.badRequest('delta must be an integer');
  if (delta === 0) return { value: null };
  if (delta < 0) return release({ tenantId, metric: 'storedRows', requested: -delta, by });
  const inc = await usageCounterRepository.incrementOrCreate({
    tenantId, metric: 'storedRows', period: 'current', delta, by, kind: 'current',
  });
  return { value: inc.value };
}

/** How long a settled or voided reservation is kept (reconciliation sees the change). */
function reservationLingerMs() {
  return Math.max(2 * (env.usage.reconcileSettleMs ?? 0), 10 * 60 * 1000);
}

/**
 * Consume `requested` now for work a queue worker finishes later, and record
 * it in the reservation ledger under `key` (the queue job id). The worker
 * draws on it through `createStoredRowsSink({ reservationKey })`;
 * `cancelReservation` gives back whatever is left. Throws `QUOTA_EXCEEDED`
 * like `checkAndConsume`; if the ledger write fails, the capacity is given
 * back before the error propagates.
 *
 * @returns {Promise<{ key: string, reserved: number }>}
 */
export async function reserve({
  tenantId,
  metric = 'storedRows',
  key,
  connectorId = null,
  requested,
  by = null,
  now = new Date(),
} = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!key) throw ApiError.badRequest('key is required');
  assertMetric(metric);
  if (periodOf(metric) !== 'current') throw ApiError.badRequest('only resource metrics can be reserved');
  if (!Number.isInteger(requested) || requested <= 0) throw ApiError.badRequest('requested must be a positive integer');
  await checkAndConsume({ tenantId, metric, requested, by, now });
  const staleAt = new Date(now.getTime() + env.usage.reservationTtlHours * 60 * 60 * 1000);
  try {
    await usageReservationRepository.create({
      tenantId,
      metric,
      key,
      connectorId,
      amount: requested,
      staleAt,
      // Backstop removal for a reservation nobody settles or voids.
      expiresAt: new Date(staleAt.getTime() + 7 * DAY_MS),
    });
  } catch (err) {
    await release({ tenantId, metric, requested, by });
    throw err;
  }
  return { key: String(key), reserved: requested };
}

/**
 * Close a reservation and give back what it has left on the counter.
 * Idempotent: a settled, voided or unknown reservation gives back nothing.
 *
 * @returns {Promise<number>} the amount given back.
 */
export async function cancelReservation({ tenantId, metric = 'storedRows', key, by = null } = {}) {
  if (!tenantId || !key) return 0;
  const left = await usageReservationRepository.settle({ tenantId, metric, key, lingerMs: reservationLingerMs() });
  if (left > 0) await release({ tenantId, metric, requested: left, by });
  return left;
}

/** Request-time capacity carried in the message itself (legacy messages, tests). */
function inMemoryCredit({ tenantId, amount, by }) {
  let credit = Math.max(0, Math.floor(Number(amount) || 0));
  return {
    async draw(max) {
      const taken = Math.min(max, credit);
      credit -= taken;
      return taken;
    },
    async giveBack(amountBack) {
      if (amountBack > 0) credit += amountBack;
    },
    async settle() {
      const unused = credit;
      credit = 0;
      if (unused > 0) await release({ tenantId, metric: 'storedRows', requested: unused, by });
      return unused;
    },
    get local() {
      return credit;
    },
  };
}

/** Request-time capacity held in the reservation ledger (survives retries and replays). */
function ledgerCredit({ tenantId, key, by }) {
  return {
    draw: (max) => usageReservationRepository.draw({ tenantId, metric: 'storedRows', key, max }),
    async giveBack(amountBack) {
      if (amountBack <= 0) return;
      const kept = await usageReservationRepository
        .giveBack({ tenantId, metric: 'storedRows', key, amount: amountBack })
        .catch(() => false);
      // The reservation is closed (settled, or voided by reconciliation):
      // only the counter still holds this capacity, so give it back there.
      if (!kept) await release({ tenantId, metric: 'storedRows', requested: amountBack, by });
    },
    // Never throws (like `release`), so a settlement problem cannot fail a
    // finished sync: an entry left open goes stale and reconciliation voids
    // it and corrects the counter.
    settle: () => cancelReservation({ tenantId, metric: 'storedRows', key, by }).catch((err) => {
      logger.warn({ err: { message: err?.message }, tenantId: String(tenantId), key }, 'usage reservation settle failed');
      return 0;
    }),
    get local() {
      return null;
    },
  };
}

/**
 * Wrap a row persistence function so `storedRows` follows the rows a sync
 * really adds. This is the one stored-rows meter for every ingestion path
 * (file, MongoDB and webhook syncs in the worker). For each batch it counts
 * which rows are new (not already stored for the connector), takes exactly
 * that many (first from the request-time reservation, then against the plan
 * limit), persists, then corrects the count to the real upsert count.
 *
 * A webhook delivery reserves its records at request time (`reserve`, so
 * the sender gets a synchronous 409 when the plan is full) and its message
 * carries `reservationKey`: the sink draws new rows from that ledger entry
 * before consuming anything more. Rows of a failed write go back to the
 * reservation, so a retried or replayed message draws exactly what is still
 * unstored. `reserved` is the older in-message form of the same credit (a
 * message without a key). `sink.settle()` gives back the part of the
 * reservation that did not become new rows; call it once the message is
 * done (success, skip or final failure), not before a queue retry. It is
 * idempotent. Nothing is counted twice.
 *
 * When the new rows of a batch do not fit a hard limit, the rows of the
 * batch that only refresh existing data are still written, then the sync
 * fails with `QUOTA_EXCEEDED` (earlier batches stay stored and counted).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.connectorId
 * @param {(batch: Array<{ sourceRowId: string, data: Object }>) => Promise<{ upserted: number, matched: number }>} opts.upsert
 * @param {string|null} [opts.reservationKey] - ledger key of the message's reservation.
 * @param {number} [opts.reserved=0] - in-message reservation (used when there is no key).
 * @param {string|null} [opts.by]
 * @returns {((batch: Array) => Promise<{ upserted: number, matched: number }>) & { settle: () => Promise<number>, readonly reserved: number|null }}
 */
export function createStoredRowsSink({ tenantId, connectorId, upsert, reserved = 0, reservationKey = null, by = null } = {}) {
  if (!tenantId || !connectorId) throw ApiError.badRequest('tenantId and connectorId are required');
  if (typeof upsert !== 'function') throw ApiError.badRequest('upsert must be a function');
  const credit = reservationKey
    ? ledgerCredit({ tenantId, key: reservationKey, by })
    : inMemoryCredit({ tenantId, amount: reserved, by });
  const sink = async (batch) => {
    if (!Array.isArray(batch) || batch.length === 0) return upsert(batch ?? []);
    const ids = [...new Set(batch.map((row) => row.sourceRowId))];
    const known = await usageSourceRepository.findExistingSourceRowIds({ tenantId, connectorId, sourceRowIds: ids });
    const fresh = Math.max(0, ids.length - known.size);
    const fromReservation = fresh > 0 ? await credit.draw(fresh) : 0;
    if (fresh > fromReservation) {
      try {
        await checkAndConsume({ tenantId, metric: 'storedRows', requested: fresh - fromReservation, by });
      } catch (err) {
        // Nothing of this batch's new rows is written: keep the reservation.
        await credit.giveBack(fromReservation);
        if (err?.code === ERROR_CODES.QUOTA_EXCEEDED && known.size > 0) {
          // Still refresh the rows that already exist, then stop the sync.
          await upsert(batch.filter((row) => known.has(row.sourceRowId)));
        }
        throw err;
      }
    }
    let res;
    try {
      res = await upsert(batch);
    } catch (err) {
      // Partial unordered bulk writes report what they inserted. The rows
      // that were not stored go back where their capacity came from: the
      // reservation first (a retry draws them again; nothing is released
      // that the retry would then store uncounted), the rest to the plan.
      const partial = Number(err?.result?.upsertedCount ?? err?.upsertedCount ?? 0) || 0;
      const unwritten = Math.max(0, fresh - partial);
      const backToReservation = Math.min(unwritten, Math.max(0, fromReservation - partial));
      await credit.giveBack(backToReservation);
      if (unwritten - backToReservation > 0) {
        await release({ tenantId, metric: 'storedRows', requested: unwritten - backToReservation, by });
      }
      throw err;
    }
    const drift = (Number(res?.upserted) || 0) - fresh;
    if (drift !== 0) await adjustStoredRows({ tenantId, delta: drift, by });
    return res;
  };
  /** Give back the reservation that did not become new rows; returns the amount. */
  sink.settle = () => credit.settle();
  Object.defineProperty(sink, 'reserved', { get: () => credit.local, enumerable: true });
  return sink;
}

/** Raw metered increment (e.g. a cumulative metric with an explicit period). */
export async function incrementCumulative({
  tenantId,
  metric,
  period,
  delta = 1,
  by = null,
} = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  assertMetric(metric);
  if (!period) throw ApiError.badRequest('period is required for cumulative metrics');
  if (!Number.isInteger(delta) || delta === 0) {
    throw ApiError.badRequest('delta must be a non-zero integer');
  }
  return usageCounterRepository.incrementOrCreate({
    tenantId,
    metric,
    period,
    delta,
    by,
    kind: 'cumulative',
  });
}

/**
 * Recount one tenant's resources and correct drifted `current` counters.
 *
 * Dry run (the default) only reports. With `dryRun: false` each drifted
 * counter is set to the real count with compare-and-set; a counter that
 * changed within `settleMs` (in-flight create or delete) or between the
 * read and the write is skipped and left for the next run.
 *
 * Capacity reserved for queued work (a webhook delivery's storedRows that
 * the worker has not stored yet) counts as in use: the real count is the
 * resources plus the open reservations (reported as `reserved`). A metric
 * whose reservations changed within `settleMs` (a worker drawing on one
 * while it writes rows) is skipped like a recently changed counter. With
 * `dryRun: false`, reservations past `env.usage.reservationTtlHours` (their
 * message is presumed lost) are voided first and no longer count.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {boolean} [opts.dryRun=true]
 * @param {string} [opts.by='system']
 * @param {number} [opts.settleMs]
 * @param {Date} [opts.now]
 * @returns {Promise<{ tenantId: string, dryRun: boolean, checkedAt: string, drifted: number, corrected: number, skipped: number, metrics: Array<Object> }>}
 */
export async function reconcile({
  tenantId,
  dryRun = true,
  by = 'system',
  settleMs = env.usage.reconcileSettleMs,
  now = new Date(),
} = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const id = String(tenantId);
  // Read the counters first, then count: a create that lands in between
  // changes the counter, which the compare-and-set then detects.
  const counters = {};
  for (const metric of RECONCILED_METRICS) {
    counters[metric] = await usageCounterRepository.findOne(id, metric, 'current');
  }
  // A reservation past its TTL belongs to a lost message: void it, so a
  // late worker cannot draw on capacity this run takes off the counter.
  if (!dryRun) await usageReservationRepository.voidStale({ tenantId: id, now, lingerMs: reservationLingerMs() });
  const actual = await usageSourceRepository.countResources(id);
  // Read after the count: a worker draws on its reservation before it
  // writes the rows, and that recent draw marks the metric as in flight.
  const reservations = await usageReservationRepository.summarize({ tenantId: id, now });
  const recentlyReserved = (metric) => {
    const at = reservations[metric]?.lastChangedAt;
    return Boolean(at) && settleMs > 0 && now - new Date(at) < settleMs;
  };

  const metrics = [];
  let corrected = 0;
  let skipped = 0;
  for (const metric of RECONCILED_METRICS) {
    const row = counters[metric];
    const recorded = row?.value ?? 0;
    const held = reservations[metric]?.outstanding ?? 0;
    const real = (actual[metric] ?? 0) + held;
    const entry = { metric, recorded, actual: real, drift: real - recorded, action: 'none' };
    if (held > 0) entry.reserved = held;
    if (entry.drift === 0) {
      metrics.push(entry);
      continue;
    }
    if (dryRun) {
      entry.action = 'would_correct';
    } else if (
      (row?.lastIncrementedAt && settleMs > 0 && now - new Date(row.lastIncrementedAt) < settleMs)
      || recentlyReserved(metric)
    ) {
      entry.action = 'skipped_recent_activity';
      skipped += 1;
    } else {
      const written = await usageCounterRepository.compareAndSet({
        tenantId: id,
        metric,
        expected: row ? { value: row.value, lastIncrementedAt: row.lastIncrementedAt ?? null } : null,
        value: real,
        by,
      });
      entry.action = written ? 'corrected' : 'skipped_concurrent_change';
      if (written) corrected += 1;
      else skipped += 1;
    }
    metrics.push(entry);
  }

  const drifted = metrics.filter((m) => m.drift !== 0).length;
  if (corrected > 0) {
    const changed = metrics.filter((m) => m.action === 'corrected');
    await auditEmit({
      actor: { type: 'system', id: String(by ?? 'system') },
      action: 'usage.reconciled',
      module: 'iam.usage',
      resource: { type: 'usage_counter', id },
      tenantId: id,
      before: Object.fromEntries(changed.map((m) => [m.metric, m.recorded])),
      after: Object.fromEntries(changed.map((m) => [m.metric, m.actual])),
      reason: 'Usage counters recounted from real resources',
    }).catch((err) => logger.warn({ err: { message: err?.message }, tenantId: id }, 'usage reconcile audit failed'));
  }
  return { tenantId: id, dryRun, checkedAt: now.toISOString(), drifted, corrected, skipped, metrics };
}

/**
 * Reconcile every tenant (or the listed ones), one at a time, in pages.
 * A failure on one tenant is recorded and the sweep continues.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true]
 * @param {string[]} [opts.tenantIds] - restrict to these tenants.
 * @param {number} [opts.batchSize=100]
 * @param {(report: Object) => void} [opts.onTenant] - progress callback.
 */
export async function reconcileAll({
  dryRun = true,
  by = 'system',
  settleMs = env.usage.reconcileSettleMs,
  tenantIds = null,
  batchSize = 100,
  onTenant = null,
} = {}) {
  const summary = { dryRun, tenants: 0, drifted: 0, corrected: 0, skipped: 0, failed: 0, reports: [] };
  const handle = async (tenantId) => {
    summary.tenants += 1;
    try {
      const report = await reconcile({ tenantId, dryRun, by, settleMs });
      summary.drifted += report.drifted;
      summary.corrected += report.corrected;
      summary.skipped += report.skipped;
      if (report.drifted > 0) summary.reports.push(report);
      if (onTenant) onTenant(report);
    } catch (err) {
      summary.failed += 1;
      const failure = { tenantId: String(tenantId), error: err?.message ?? 'unknown' };
      summary.reports.push(failure);
      if (onTenant) onTenant(failure);
    }
  };
  if (Array.isArray(tenantIds) && tenantIds.length > 0) {
    for (const tenantId of tenantIds) await handle(tenantId);
    return summary;
  }
  let afterId = null;
  for (;;) {
    const page = await usageSourceRepository.listTenantIds({ afterId, limit: batchSize });
    if (page.length === 0) break;
    for (const tenantId of page) await handle(tenantId);
    afterId = page[page.length - 1];
    if (page.length < batchSize) break;
  }
  return summary;
}

export default {
  checkAndConsume,
  withQuota,
  release,
  assertCapacity,
  meterApiCall,
  adjustStoredRows,
  reserve,
  cancelReservation,
  createStoredRowsSink,
  incrementCumulative,
  reconcile,
  reconcileAll,
  RECONCILED_METRICS,
  _meta: { module: 'iam.usage', authoritative: true },
};
