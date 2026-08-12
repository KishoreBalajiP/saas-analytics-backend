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

/** Find enabled alerts whose next evaluation is due (or never set). */
export const findDueRules = async ({ now = new Date(), limit = 100 } = {}) =>
  AlertRule.find({
    enabled: true,
    $or: [{ nextEvaluationAt: { $lte: now } }, { nextEvaluationAt: null }],
  })
    .limit(limit)
    .lean();

/** Record evaluation timestamps + projected next evaluation. */
export const markEvaluated = (id, { lastEvaluatedAt, lastTriggeredAt, nextEvaluationAt }) => {
  const patch = { lastEvaluatedAt };
  if (lastTriggeredAt) patch.lastTriggeredAt = lastTriggeredAt;
  if (nextEvaluationAt !== undefined) patch.nextEvaluationAt = nextEvaluationAt;
  return AlertRule.findByIdAndUpdate(id, { $set: patch }, { new: true, lean: true });
};

export default {
  listRules,
  findRuleById,
  createRule,
  updateRule,
  removeRule,
  listEvents,
  createEvent,
  findDueRules,
  markEvaluated,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
