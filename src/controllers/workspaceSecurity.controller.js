/**
 * Workspace Security Controller (roadmap 4.E1, mfa-tenant).
 *
 * HTTP layer for `/api/v1/workspace/security`. The tenant comes from the
 * resolved request context and the actor from the verified token, never
 * from the body.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import workspaceSecurityService from '../services/workspaceSecurity.service.js';

function tenantOf(req) {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  return tenantId;
}

/** GET /api/v1/workspace/security */
export const getPolicy = asyncHandler(async (req, res) => {
  const policy = await workspaceSecurityService.getPolicy({ tenantId: tenantOf(req) });
  return ApiResponse.ok(res, policy, 'Workspace security policy');
});

/** PATCH /api/v1/workspace/security */
export const updatePolicy = asyncHandler(async (req, res) => {
  const policy = await workspaceSecurityService.setPolicy({
    tenantId: tenantOf(req),
    actorId: req.user?.id ?? null,
    mfaRequired: req.validated.body.mfaRequired,
  });
  return ApiResponse.ok(res, policy, 'Workspace security policy updated');
});

/** GET /api/v1/workspace/security/members */
export const listMembers = asyncHandler(async (req, res) => {
  const members = await workspaceSecurityService.listMembers({ tenantId: tenantOf(req) });
  return ApiResponse.ok(res, members, 'Member MFA status', { total: members.length });
});

/** POST /api/v1/workspace/security/members/:userId/mfa/reset */
export const resetMemberMfa = asyncHandler(async (req, res) => {
  const result = await workspaceSecurityService.resetMemberMfa({
    tenantId: tenantOf(req),
    actorId: req.user.id,
    userId: req.validated.params.userId,
    reason: req.validated.body.reason,
  });
  return ApiResponse.ok(res, result, 'Member MFA reset');
});

export default { getPolicy, updatePolicy, listMembers, resetMemberMfa };
