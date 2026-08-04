/**
 * Support Service (architecture placeholder).
 *
 * PURPOSE
 *   Orchestrates the privileged admin tools (impersonation, account
 *   recovery, lookups, broadcasting). Every action audits + accessLogs.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - impersonate({ targetUserId, reason })
 *   - stopImpersonation
 *   - recoverAccount({ userId })
 *   - revokeAllSessions({ userId })
 *   - getTenantLookups(tenantId)
 *   - broadcastNotification({ tenantScope?, templateKey, data })
 *
 * CODING GUIDELINES
 *   - `reason` is mandatory; service throws 400 when missing.
 *   - Per-admin daily cap is enforced (`impersonationBudget.admin.dailyCap`).
 *   - Audit + access log writes are wrapped in a single batched
 *     `services/auditLog.service#emitMany(...)` to keep correlation.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const impersonate = notImplementedStub('support.service', 'impersonate');
export const stopImpersonation = notImplementedStub('support.service', 'stopImpersonation');
export const recoverAccount = notImplementedStub('support.service', 'recoverAccount');
export const revokeAllSessions = notImplementedStub('support.service', 'revokeAllSessions');
export const getTenantLookups = notImplementedStub('support.service', 'getTenantLookups');
export const broadcastNotification = notImplementedStub('support.service', 'broadcastNotification');

export default {
  impersonate, stopImpersonation, recoverAccount,
  revokeAllSessions, getTenantLookups, broadcastNotification,
  _meta: { reasonRequired: true, audits: ['governance.audit-logs', 'governance.access-logs'] },
};
