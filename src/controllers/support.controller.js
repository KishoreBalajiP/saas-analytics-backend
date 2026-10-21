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
// support: access redesign (roadmap 2.3).
import * as supportAccessService from '../services/supportAccess.service.js';
import * as supportDiagnosticsService from '../services/supportDiagnostics.service.js';

/** Pull the acting context off an authenticated request. */
function ctx(req) {
  return {
    actor: req.admin,
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.id ?? null,
  };
}

/** POST /support/impersonate - start a read-only support session. */
export const impersonate = asyncHandler(async (req, res) => {
  const { targetUserId, reason, ticket } = req.validated?.body ?? {};
  const data = await supportService.impersonate({ ...ctx(req), targetUserId, reason, ticket });
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

/* ---------------- support: access redesign (roadmap 2.3) ----------------- */

function pageMeta(result) {
  return { page: result.page, limit: result.limit, total: result.total, pages: result.pages };
}

/** GET /support/tenants/:id/diagnostics - sanitised operational facts. */
export const getTenantDiagnostics = asyncHandler(async (req, res) => {
  const tenantId = req.validated?.params?.id;
  const data = await supportDiagnosticsService.getTenantDiagnostics({ ...ctx(req), tenantId });
  return ApiResponse.ok(res, data, 'Tenant diagnostics');
});

/** GET /support/access-grants - consent and break-glass grants (scoped). */
export const listAccessGrants = asyncHandler(async (req, res) => {
  const { tenantId, status, kind, page, limit } = req.validated?.query ?? {};
  const result = await supportAccessService.listGrantsForAdmin({ actor: req.admin, tenantId, status, kind, page, limit });
  return ApiResponse.ok(res, result.docs, 'Support access grants', pageMeta(result));
});

/** POST /support/access-grants/break-glass - request incident access. */
export const requestBreakGlass = asyncHandler(async (req, res) => {
  const { tenantId, reason, ticket } = req.validated?.body ?? {};
  const data = await supportAccessService.requestBreakGlass({ ...ctx(req), tenantId, reason, ticket });
  return ApiResponse.created(res, data, 'Break-glass access requested');
});

/** POST /support/access-grants/:id/approve - a super admin approves. */
export const approveBreakGlass = asyncHandler(async (req, res) => {
  const data = await supportAccessService.approveBreakGlass({
    ...ctx(req),
    grantId: req.validated?.params?.id,
    reason: req.validated?.body?.reason,
  });
  return ApiResponse.ok(res, data, 'Break-glass access approved');
});

/** POST /support/access-grants/:id/deny - a super admin denies. */
export const denyBreakGlass = asyncHandler(async (req, res) => {
  const data = await supportAccessService.denyBreakGlass({
    ...ctx(req),
    grantId: req.validated?.params?.id,
    reason: req.validated?.body?.reason,
  });
  return ApiResponse.ok(res, data, 'Break-glass access denied');
});

/** POST /support/access-grants/:id/revoke - give up a grant early. */
export const revokeAccessGrant = asyncHandler(async (req, res) => {
  const data = await supportAccessService.revokeGrantAsAdmin({
    ...ctx(req),
    grantId: req.validated?.params?.id,
    reason: req.validated?.body?.reason,
  });
  return ApiResponse.ok(res, data, 'Support access revoked');
});

/** GET /support/impersonations - support sessions (scoped). */
export const listImpersonations = asyncHandler(async (req, res) => {
  const { tenantId, status, mine, page, limit } = req.validated?.query ?? {};
  const result = await supportAccessService.listImpersonationsForAdmin({
    actor: req.admin,
    tenantId,
    status,
    mine: mine === true,
    page,
    limit,
  });
  return ApiResponse.ok(res, result.docs, 'Support sessions', pageMeta(result));
});

export default {
  impersonate,
  stopImpersonation,
  recoverAccount,
  revokeAllSessions,
  getTenantLookups,
  broadcastNotification,
  // support:
  getTenantDiagnostics,
  listAccessGrants,
  requestBreakGlass,
  approveBreakGlass,
  denyBreakGlass,
  revokeAccessGrant,
  listImpersonations,
  _meta: { phase: '8 - implemented' },
};
