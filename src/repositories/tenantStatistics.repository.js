/**
 * Tenant Statistics Repository (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the tenant statistics endpoint. Counts live
 *   under the tenancy unit across the collections that define "activity"
 *   for a tenant.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - countUsers / countActiveSessions / countDashboards / countReports
 *   - lastActivityAt - the most recent user login in the tenant
 *
 * CODING GUIDELINES
 *   - Every query filters by `tenantId` explicitly.
 *   - No pagination needed; these are single aggregate numbers.
 */

import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';

/** Non-deleted users in the tenant. */
export const countUsers = (tenantId) => User.countDocuments({ tenantId });

/** Currently active (non-revoked) sessions in the tenant. */
export const countActiveSessions = (tenantId) =>
  Session.countDocuments({ tenantId, status: 'active' });

/** Audit events recorded against the tenant (the activity trail). */
export const countAuditEvents = (tenantId) => AuditLog.countDocuments({ tenantId });

/** Most recent user login in the tenant (or null when nobody logged in). */
export const lastActivityAt = async (tenantId) => {
  const user = await User.findOne({ tenantId }).sort({ lastLoginAt: -1 }).select('lastLoginAt').lean();
  return user?.lastLoginAt ?? null;
};

export default {
  countUsers,
  countActiveSessions,
  countAuditEvents,
  lastActivityAt,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
