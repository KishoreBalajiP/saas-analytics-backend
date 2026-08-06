/**
 * LoginAttempt Repository (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Append-only data-access surface for authentication attempts backed by
 *   `models/LoginAttempt.js`. Complements the persisted lockout counters on
 *   `User` / `Admin` with a queryable trail (who, from where, when, why).
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - record, list, recentFailures
 *
 * CODING GUIDELINES
 *   - INSERT ONLY: there are no update/delete paths here - this collection
 *     is append-only and pruned only by the Sprint 7 retention job.
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Lookups are by actor/email/IP and bounded by `since` so the lockout
 *     window (a service policy) stays cheap to query.
 */

import { LoginAttempt } from '../models/LoginAttempt.js';

/** Append one authentication attempt. Returns the plain record. */
export const record = async (data) => {
  const doc = await LoginAttempt.create(data);
  return doc.toObject();
};

/** Paginated attempt log. Any filter field may be omitted. */
export const list = async ({
  actorId,
  email,
  ip,
  success,
  page = 1,
  limit = 20,
} = {}) => {
  const filter = {};
  if (actorId) filter.actorId = actorId;
  if (email) filter.email = email.toLowerCase();
  if (ip) filter.ip = ip;
  if (success !== undefined) filter.success = success;
  const result = await LoginAttempt.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { occurredAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Recent failed attempts for an actor/email/IP within the lockout window. */
export const recentFailures = ({
  actorId,
  email,
  ip,
  since,
  limit = 20,
} = {}) => {
  const filter = { success: false };
  if (actorId) filter.actorId = actorId;
  if (email) filter.email = email.toLowerCase();
  if (ip) filter.ip = ip;
  if (since) filter.occurredAt = { $gte: since };
  return LoginAttempt.find(filter).sort({ occurredAt: -1 }).limit(limit).lean();
};

export default {
  record,
  list,
  recentFailures,
  _meta: { appendOnly: true, leanReturns: true, tenancy: 'hybrid' },
};
