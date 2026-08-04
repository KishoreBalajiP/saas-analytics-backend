/**
 * Support Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/support`. Admin-only escape hatch:
 *   impersonation, recovery, lookups, broadcasting.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - impersonate, stopImpersonation, recoverAccount, revokeAllSessions
 *   - getTenantLookups, broadcastNotification
 *
 * CODING GUIDELINES
 *   - `reason` is mandatory on every body. Validator rejects 422.
 *   - Impersonation respects `impersonationBudget.admin.dailyCap`.
 *   - All calls flow through `audit` + `accessLog` middleware.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const impersonate = notImplemented('POST /support/impersonate');
export const stopImpersonation = notImplemented('POST /support/impersonate/stop');
export const recoverAccount = notImplemented('POST /support/account/recover');
export const revokeAllSessions = notImplemented('POST /support/account/revoke-sessions');
export const getTenantLookups = notImplemented('GET /support/tenants/:id/lookups');
export const broadcastNotification = notImplemented('POST /support/notifications/broadcast');

export default {
  impersonate, stopImpersonation, recoverAccount,
  revokeAllSessions, getTenantLookups, broadcastNotification,
};
