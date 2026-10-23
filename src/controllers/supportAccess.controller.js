/**
 * Support Access Controller (roadmap 2.3).
 *
 * PURPOSE
 *   HTTP entry for the workspace side of support access
 *   (`/api/v1/workspace/support-access`) and for the support session itself
 *   (`/api/v1/support-session`). Identity comes from `req.user` (set by
 *   `authenticate` / `authenticateImpersonation`), the tenant from
 *   `req.tenant` (set by `resolveTenant`), and inputs from `req.validated`.
 *
 * RESPONSIBILITY
 *   Thin translation only; policy lives in `supportAccess.service.js`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as supportAccessService from '../services/supportAccess.service.js';

function requestMeta(req) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.id ?? null,
  };
}

function tenantOf(req) {
  return req.tenant?.id ?? req.user?.tenantId ?? null;
}

/** GET /workspace/support-access - usable grant, grants and support sessions. */
export const getWorkspaceSupportAccess = asyncHandler(async (req, res) => {
  const { page, limit } = req.validated?.query ?? {};
  const data = await supportAccessService.getWorkspaceSupportAccess({
    tenantId: tenantOf(req),
    page,
    limit,
  });
  return ApiResponse.ok(res, data, 'Support access');
});

/** GET /workspace/support-access/activity - support audit history (paged). */
export const listWorkspaceSupportActivity = asyncHandler(async (req, res) => {
  const { page, limit } = req.validated?.query ?? {};
  const result = await supportAccessService.listWorkspaceSupportActivity({ tenantId: tenantOf(req), page, limit });
  return ApiResponse.ok(res, result.docs, 'Support activity', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /workspace/support-access/grants - grant time-boxed support access. */
export const grantConsent = asyncHandler(async (req, res) => {
  const { durationHours, note } = req.validated?.body ?? {};
  const data = await supportAccessService.grantConsent({
    ...requestMeta(req),
    tenantId: tenantOf(req),
    user: req.user,
    durationHours,
    note: note ?? null,
  });
  return ApiResponse.created(res, data, 'Support access granted');
});

/** POST /workspace/support-access/grants/:id/revoke - revoke a consent. */
export const revokeConsent = asyncHandler(async (req, res) => {
  const data = await supportAccessService.revokeConsent({
    ...requestMeta(req),
    tenantId: tenantOf(req),
    grantId: req.validated?.params?.id,
    user: req.user,
    reason: req.validated?.body?.reason ?? null,
  });
  return ApiResponse.ok(res, data, 'Support access revoked');
});

/** POST /workspace/support-access/sessions/:id/end - end a support session. */
export const endSessionAsWorkspace = asyncHandler(async (req, res) => {
  const data = await supportAccessService.endSessionAsWorkspace({
    ...requestMeta(req),
    tenantId: tenantOf(req),
    sessionId: req.validated?.params?.id,
    user: req.user,
    reason: req.validated?.body?.reason ?? null,
  });
  return ApiResponse.ok(res, data, 'Support session ended');
});

/** GET /support-session - the caller's support session, if it is one. */
export const getCurrentSupportSession = asyncHandler(async (req, res) => {
  const data = await supportAccessService.getCurrentSupportSession({ user: req.user });
  return ApiResponse.ok(res, data, 'Support session');
});

/** POST /support-session/end - a support session ends itself. */
export const endCurrentSupportSession = asyncHandler(async (req, res) => {
  const data = await supportAccessService.endCurrentSupportSession({
    ...requestMeta(req),
    user: req.user,
    reason: req.validated?.body?.reason ?? null,
  });
  return ApiResponse.ok(res, data, 'Support session ended');
});

export default {
  getWorkspaceSupportAccess,
  listWorkspaceSupportActivity,
  grantConsent,
  revokeConsent,
  endSessionAsWorkspace,
  getCurrentSupportSession,
  endCurrentSupportSession,
};
