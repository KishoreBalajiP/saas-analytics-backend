/**
 * Alert Repository (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for alert rules and their evaluation events.
 *   Database access ONLY - no business logic (threshold comparison, cooldown,
 *   notification dispatch all live in `alert.service.js`).
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant scoping is explicit (`tenantId`) plus the `tenantScope` plugin.
 */

import { AlertRule } from '../models/AlertRule.js';
import { AlertEvent } from '../models/AlertEvent.js';

/* ------------------------------- rules ---------------------------------- */

export const listRules = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await AlertRule.paginate(query, { page, limit, lean: true, sort: { updatedAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

export const findRuleById = (id, { tenantId } = {}) =>
  AlertRule.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

export const createRule = async (data) => {
  const doc = new AlertRule(data);
  await doc.save();
  return doc.toObject();
};

export const updateRule = (id, patch) =>
  AlertRule.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

export const removeRule = async (id, by) => {
  const doc = await AlertRule.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/**
 * Cursor over every (non-deleted) rule, optionally of some tenants only.
 * Read-only maintenance scans (e.g. the alert metric audit) iterate it.
 */
export const cursorRules = ({ tenantIds = null } = {}) =>
  AlertRule.find(Array.isArray(tenantIds) && tenantIds.length ? { tenantId: { $in: tenantIds.map(String) } } : {})
    .sort({ _id: 1 })
    .lean()
    .cursor();

/* ------------------------------- events ---------------------------------- */

export const listEvents = async ({ tenantId, alertId, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (tenantId) filter.tenantId = tenantId;
  if (alertId) filter.alertId = alertId;
  const result = await AlertEvent.paginate(filter, { page, limit, lean: true, sort: { triggeredAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

export const createEvent = async (data) => {
  const doc = new AlertEvent(data);
  await doc.save();
  return doc.toObject();
};

/* ------------------------------ scheduler -------------------------------- */

/**
 * Find enabled alerts whose next evaluation is due (or never set), oldest
 * first. Candidates only: the caller must `claimDueRule` each one.
 */
export const findDueRules = async ({ now = new Date(), limit = 100 } = {}) =>
  AlertRule.find({
    enabled: true,
    $and: [
      { $or: [{ nextEvaluationAt: { $lte: now } }, { nextEvaluationAt: null }] },
      { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    ],
  })
    .sort({ nextEvaluationAt: 1 })
    .limit(limit)
    .select({ _id: 1, tenantId: 1, nextEvaluationAt: 1, schedule: 1 })
    .lean();

/**
 * Atomically claim one due rule: matches only while `nextEvaluationAt` still
 * has the value the scan saw and no live lease exists, and advances
 * `nextEvaluationAt` in the same write. Exactly one concurrent caller wins.
 */
export const claimDueRule = ({ id, expectedNextEvaluationAt, nextEvaluationAt, owner, leaseMs, now = new Date() }) =>
  AlertRule.findOneAndUpdate(
    {
      _id: id,
      enabled: true,
      nextEvaluationAt: expectedNextEvaluationAt ?? null,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        nextEvaluationAt,
        lockedBy: owner,
        lockedUntil: new Date(now.getTime() + leaseMs),
      },
    },
    { new: true, lean: true },
  );

/** Release a rule claim held by `owner`. */
export const releaseRuleClaim = (id, owner) =>
  AlertRule.updateOne({ _id: id, lockedBy: owner }, { $set: { lockedBy: null, lockedUntil: null } });

/** Record evaluation timestamps, the outcome and the projected next evaluation. */
export const markEvaluated = (id, { lastEvaluatedAt, lastTriggeredAt, nextEvaluationAt, lastEvaluation }) => {
  const patch = { lastEvaluatedAt };
  if (lastTriggeredAt) patch.lastTriggeredAt = lastTriggeredAt;
  if (nextEvaluationAt !== undefined) patch.nextEvaluationAt = nextEvaluationAt;
  if (lastEvaluation !== undefined) patch.lastEvaluation = lastEvaluation;
  return AlertRule.findByIdAndUpdate(id, { $set: patch }, { new: true, lean: true });
};

/**
 * Atomically take the right to trigger: succeeds (returns the updated rule)
 * only when the rule has never triggered or its cooldown has elapsed, and
 * stamps `lastTriggeredAt` in the same write. Two concurrent evaluations of
 * a firing rule therefore trigger (and notify) exactly once per cooldown;
 * the loser gets null and records a suppressed evaluation instead.
 */
export const claimTrigger = ({ id, now, cooldownMs, nextEvaluationAt, lastEvaluation }) =>
  AlertRule.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { lastTriggeredAt: null },
        { lastTriggeredAt: { $lte: new Date(now.getTime() - Math.max(0, cooldownMs)) } },
      ],
    },
    {
      $set: {
        lastTriggeredAt: now,
        lastEvaluatedAt: now,
        ...(nextEvaluationAt !== undefined ? { nextEvaluationAt } : {}),
        ...(lastEvaluation !== undefined ? { lastEvaluation } : {}),
      },
    },
    { new: true, lean: true },
  );

export default {
  listRules,
  findRuleById,
  createRule,
  updateRule,
  removeRule,
  cursorRules,
  listEvents,
  createEvent,
  findDueRules,
  claimDueRule,
  releaseRuleClaim,
  markEvaluated,
  claimTrigger,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
