/**
 * SecurityAlert Repository (roadmap 2.6).
 *
 * PURPOSE
 *   Data access for `models/SecurityAlert.js`: the detector's create/merge
 *   path (one active alert per dedupe key), the admin triage reads, and the
 *   conditional status transitions.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Every status change is a conditional update on the current status, so
 *     two admins triaging the same alert cannot both win.
 *   - Platform-level collection: no tenant scoping (tenantId is a filter).
 */

import {
  SecurityAlert,
  ACTIVE_ALERT_STATUSES,
  MAX_EVIDENCE_REFS,
  MAX_HISTORY,
} from '../models/SecurityAlert.js';

const DUPLICATE_KEY = 11000;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The active (open/acknowledged) alert for a dedupe key, if any. */
export const findActiveByKey = (dedupeKey) => SecurityAlert.findOne({ activeKey: dedupeKey }).lean();

/**
 * Insert a new active alert. Returns the plain document, or `null` when an
 * active alert with the same dedupe key appeared concurrently (the caller
 * then merges into it).
 */
export const createActive = async (data) => {
  try {
    const doc = await SecurityAlert.create({ ...data, activeKey: data.dedupeKey, status: 'open' });
    return doc.toObject();
  } catch (err) {
    if (err?.code === DUPLICATE_KEY) return null;
    throw err;
  }
};

/**
 * Merge a repeated detection into the active alert for `dedupeKey`
 * (single atomic pipeline update): bump occurrences, extend lastSeenAt and
 * the window, escalate severity (never lowers it), replace the latest
 * counts/details, append evidence refs without duplicates (newest
 * MAX_EVIDENCE_REFS kept) and a history entry.
 *
 * @returns {Promise<Object|null>} the alert BEFORE the merge, or null when
 *   no active alert exists any more.
 */
export const mergeIntoActive = (dedupeKey, {
  lastSeenAt,
  windowStart = null,
  windowEnd = null,
  severity,
  severityRank,
  counts = null,
  details = null,
  refs = [],
  history,
}) => {
  const refKeys = refs.map((ref) => `${ref.source}:${ref.id ?? ''}`);
  const stage = {
    lastSeenAt: { $max: ['$lastSeenAt', lastSeenAt] },
    windowEnd: { $max: ['$windowEnd', windowEnd ?? lastSeenAt] },
    windowStart: windowStart
      ? { $cond: [{ $or: [{ $eq: ['$windowStart', null] }, { $gt: ['$windowStart', windowStart] }] }, windowStart, '$windowStart'] }
      : '$windowStart',
    occurrences: { $add: [{ $ifNull: ['$occurrences', 1] }, 1] },
    severity: { $cond: [{ $gt: [severityRank, '$severityRank'] }, severity, '$severity'] },
    severityRank: { $max: ['$severityRank', severityRank] },
    'evidence.counts': { $literal: counts },
    'evidence.details': { $literal: details },
    'evidence.refs': {
      $slice: [
        {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ['$evidence.refs', []] },
                as: 'ref',
                cond: {
                  $not: [{
                    $in: [{ $concat: ['$$ref.source', ':', { $ifNull: ['$$ref.id', ''] }] }, { $literal: refKeys }],
                  }],
                },
              },
            },
            { $literal: refs },
          ],
        },
        -MAX_EVIDENCE_REFS,
      ],
    },
    history: {
      $slice: [{ $concatArrays: [{ $ifNull: ['$history', []] }, { $literal: [history] }] }, -MAX_HISTORY],
    },
  };
  return SecurityAlert.findOneAndUpdate({ activeKey: dedupeKey }, [{ $set: stage }], {
    new: false,
    lean: true,
    runValidators: false,
  });
};

/** Append a history entry (e.g. `escalated`) to an alert. */
export const appendHistory = (id, entry) =>
  SecurityAlert.updateOne({ _id: id }, { $push: { history: { $each: [entry], $slice: -MAX_HISTORY } } });

/**
 * The most recent CLOSED alert with this dedupe key closed at or after
 * `since` with the given status (false-positive suppression).
 */
export const findRecentlyClosed = ({ dedupeKey, status, since }) =>
  SecurityAlert.findOne({ dedupeKey, status, closedAt: { $gte: since } }).sort({ closedAt: -1 }).lean();

/**
 * Atomically claim the right to notify for an alert (first caller wins).
 * Returns the claimed alert or null when it was already notified.
 */
export const claimNotification = (id, at = new Date()) =>
  SecurityAlert.findOneAndUpdate(
    { _id: id, notifiedAt: null },
    { $set: { notifiedAt: at } },
    { new: true, lean: true },
  );

/** Record notification outcomes on the alert. */
export const recordNotifications = (id, entries, at = new Date()) =>
  SecurityAlert.findOneAndUpdate(
    { _id: id },
    {
      $push: {
        notifications: { $each: entries, $slice: -50 },
        history: {
          $each: [{ at, action: 'notified', by: null, note: `${entries.length} notification(s)` }],
          $slice: -MAX_HISTORY,
        },
      },
    },
    { new: true, lean: true },
  );

/** Single alert by id (null when missing or malformed id). */
export const findById = async (id) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(id ?? ''))) return null;
  return SecurityAlert.findById(id).lean();
};

/** Build the triage filter. Every value is coerced to a safe scalar. */
export function buildFilter({ status, severity, ruleId, tenantId, search, from, to } = {}) {
  const filter = {};
  const asList = (value) => (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
  if (status) filter.status = { $in: asList(status) };
  if (severity) filter.severity = { $in: asList(severity) };
  if (ruleId) filter.ruleId = String(ruleId);
  if (tenantId) filter.tenantId = String(tenantId);
  if (from || to) {
    filter.lastSeenAt = {};
    if (from) filter.lastSeenAt.$gte = new Date(from);
    if (to) filter.lastSeenAt.$lte = new Date(to);
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(String(search).slice(0, 100)), 'i');
    filter.$or = [{ title: pattern }, { 'subject.id': pattern }, { 'subject.display': pattern }];
  }
  return filter;
}

/** Paginated triage list: newest activity first. */
export const list = async ({ filter = {}, page = 1, limit = 20, sort = { lastSeenAt: -1, _id: -1 } } = {}) => {
  const result = await SecurityAlert.paginate(filter, {
    page,
    limit,
    lean: true,
    sort,
    // The list omits the heavy parts; GET /:id returns the full alert.
    select: '-history -evidence.refs -notifications',
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Count alerts per status (ignores the status filter itself). */
export const countByStatus = async (filter = {}) => {
  const { status: _ignored, ...rest } = filter;
  const rows = await SecurityAlert.aggregate([
    { $match: rest },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = { open: 0, acknowledged: 0, false_positive: 0, resolved: 0 };
  for (const row of rows) counts[row._id] = row.count;
  return counts;
};

/**
 * Conditional status transition: applies only while the alert is in one of
 * `fromStatuses`. Closing unsets `activeKey` so a later detection opens a
 * new alert. Returns the updated alert or null when the condition failed.
 */
export const transition = (id, { fromStatuses, set, unsetActive = false, history }) => {
  const update = {
    $set: set,
    $push: { history: { $each: [history], $slice: -MAX_HISTORY } },
  };
  if (unsetActive) update.$unset = { activeKey: 1 };
  return SecurityAlert.findOneAndUpdate(
    { _id: id, status: { $in: fromStatuses } },
    update,
    { new: true, lean: true, runValidators: true },
  );
};

/** Count active alerts (monitoring / tests). */
export const countActive = () => SecurityAlert.countDocuments({ status: { $in: [...ACTIVE_ALERT_STATUSES] } });

export default {
  findActiveByKey,
  createActive,
  mergeIntoActive,
  appendHistory,
  findRecentlyClosed,
  claimNotification,
  recordNotifications,
  findById,
  buildFilter,
  list,
  countByStatus,
  transition,
  countActive,
};
