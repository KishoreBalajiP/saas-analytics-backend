/**
 * Support Controller (Sprint 8 - implemented).
 *
 * PURPOSE
 *   HTTP entry for `/api/v1/admin/support/*`: impersonation, account
 *   recovery, session revocation, tenant lookups and broadcasts. Read-only
 *   identity comes from `req.admin` (set by adminAuth); `req.validated`
 *   carries the sanitised body/params (set by the validator middleware).
 *
 * RESPONSIBILITY
 *   - Thin translation layer: pull identity/context off the request, hand a
 *     plain object to the service, wrap the result in the standard envelope.
 *   - Never mutates `req.admin` and never performs policy itself.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as supportService from '../services/support.service.js';

/** Pull the acting context off an authenticated request. */
function ctx(req) {
  return {
    actor: req.admin,
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.id ?? null,
  };
}

/** POST /support/impersonate - start an impersonation session. */
export const impersonate = asyncHandler(async (req, res) => {
  const { targetUserId, reason } = req.validated?.body ?? {};
  const data = await supportService.impersonate({ ...ctx(req), targetUserId, reason });
  return ApiResponse.ok(res, data, 'Impersonation started');
});

/** POST /support/impersonate/stop - end an impersonation session. */
export const stopImpersonation = asyncHandler(async (req, res) => {
  const { sessionId, reason } = req.validated?.body ?? {};
  const data = await supportService.stopImpersonation({ ...ctx(req), sessionId, reason });
  return ApiResponse.ok(res, data, 'Impersonation stopped');
});

/** POST /support/account/recover - admin-initiated password reset by email. */
export const recoverAccount = asyncHandler(async (req, res) => {
  const { userId, reason } = req.validated?.body ?? {};
  const data = await supportService.recoverAccount({ ...ctx(req), userId, reason });
  return ApiResponse.ok(res, data, 'Recovery email requested');
});

/** POST /support/account/revoke-sessions - lock a user's devices out. */
export const revokeAllSessions = asyncHandler(async (req, res) => {
  const { userId, reason } = req.validated?.body ?? {};
  const data = await supportService.revokeAllSessions({ ...ctx(req), userId, reason });
  return ApiResponse.ok(res, data, 'Sessions revoked');
});

/** GET /support/tenants/:id/lookups - tenant overview for a support admin. */
export const getTenantLookups = asyncHandler(async (req, res) => {
  const tenantId = req.validated?.params?.id;
  const data = await supportService.getTenantLookups({ ...ctx(req), tenantId });
  return ApiResponse.ok(res, data, 'Tenant lookups');
});

/** POST /support/notifications/broadcast - tenant-scoped in-app broadcast. */
export const broadcastNotification = asyncHandler(async (req, res) => {
  const { tenantId, title, body, type, reason } = req.validated?.body ?? {};
  const data = await supportService.broadcastNotification({ ...ctx(req), tenantId, title, body, type, reason });
  return ApiResponse.ok(res, data, 'Broadcast queued');
});

export default {
  impersonate,
  stopImpersonation,
  recoverAccount,
  revokeAllSessions,
  getTenantLookups,
  broadcastNotification,
  _meta: { phase: '8 - implemented' },
};
