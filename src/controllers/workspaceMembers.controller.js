/**
 * Workspace Members Controller (roadmap 2.10).
 *
 * HTTP layer for the tenant self-service membership surface under
 * `/api/v1/workspace`: members, invitations, roles, ownership transfer and
 * workspace deletion. The tenant always comes from the caller's token; the
 * services enforce the ceiling, last-owner and self-modification rules.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import permissionService from '../services/permission.service.js';
import tenantMemberService from '../services/tenantMember.service.js';
import tenantRoleService from '../services/tenantRole.service.js';
import invitationService from '../services/tenantInvitation.service.js';
import tenantDeletionService from '../services/tenantDeletion.service.js';
import { transferOwnership, verifyStepUp } from '../services/tenantOwnership.service.js';

function tenantOf(req) {
  const tenantId = req.user?.tenantId ?? null;
  if (!tenantId) throw ApiError.forbidden('A workspace session is required');
  return String(tenantId);
}

const actorOf = (req) => String(req.user.id);

function pageMeta(result) {
  return { page: result.page, limit: result.limit, total: result.total, pages: result.pages };
}

/** Viewers see names only; people who invite or manage members see emails. */
async function canSeeContact(req) {
  const keys = await permissionService.resolveActorPermissions({
    actorType: 'user', actorId: actorOf(req), tenantId: tenantOf(req),
  });
  return keys.includes('users.create') || keys.includes('users.update');
}

/* -------------------------------- members -------------------------------- */

export const listMembers = asyncHandler(async (req, res) => {
  const { search, status, page, limit } = req.validated?.query ?? {};
  const result = await tenantMemberService.listMembers({
    tenantId: tenantOf(req),
    search,
    status,
    includeEmail: await canSeeContact(req),
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Members fetched', pageMeta(result));
});

export const getMember = asyncHandler(async (req, res) => {
  const member = await tenantMemberService.getMember({
    tenantId: tenantOf(req), userId: req.validated.params.userId, includeEmail: await canSeeContact(req),
  });
  return ApiResponse.ok(res, member, 'Member fetched');
});

export const setMemberRoles = asyncHandler(async (req, res) => {
  const member = await tenantMemberService.setMemberRoles({
    tenantId: tenantOf(req),
    userId: req.validated.params.userId,
    roleIds: req.validated.body.roleIds,
    by: actorOf(req),
  });
  return ApiResponse.ok(res, member, 'Member roles updated');
});

export const deactivateMember = asyncHandler(async (req, res) => {
  const result = await tenantMemberService.deactivate({
    tenantId: tenantOf(req),
    userId: req.validated.params.userId,
    by: actorOf(req),
    reason: req.validated.body?.reason ?? null,
  });
  return ApiResponse.ok(res, result, result.changed ? 'Member deactivated' : 'Member already deactivated');
});

export const reactivateMember = asyncHandler(async (req, res) => {
  const result = await tenantMemberService.reactivate({
    tenantId: tenantOf(req),
    userId: req.validated.params.userId,
    by: actorOf(req),
    reason: req.validated.body?.reason ?? null,
  });
  return ApiResponse.ok(res, result, result.changed ? 'Member reactivated' : 'Member already active');
});

export const removeMember = asyncHandler(async (req, res) => {
  const result = await tenantMemberService.removeMember({
    tenantId: tenantOf(req),
    userId: req.validated.params.userId,
    by: actorOf(req),
  });
  return ApiResponse.ok(res, result, 'Member removed');
});

/* ------------------------------ invitations ------------------------------ */

export const listInvitations = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.validated?.query ?? {};
  const result = await invitationService.list({ tenantId: tenantOf(req), status, page: page ?? 1, limit: limit ?? 20 });
  return ApiResponse.ok(res, result.docs, 'Invitations fetched', pageMeta(result));
});

export const resendInvitation = asyncHandler(async (req, res) => {
  const result = await invitationService.resend({
    tenantId: tenantOf(req),
    invitationId: req.validated.params.invitationId,
    invitedBy: actorOf(req),
    actorType: 'user',
  });
  const data = { invitation: result.invitation, delivered: result.delivered };
  return result.delivered
    ? ApiResponse.ok(res, data, 'Invitation resent')
    : ApiResponse.accepted(res, data, 'Invitation updated but email delivery failed');
});

export const revokeInvitation = asyncHandler(async (req, res) => {
  const invitation = await invitationService.revoke({
    id: req.validated.params.invitationId,
    tenantId: tenantOf(req),
    by: actorOf(req),
    actorType: 'user',
  });
  return ApiResponse.ok(res, invitation, 'Invitation revoked');
});

/* --------------------------------- roles --------------------------------- */

export const listRoles = asyncHandler(async (req, res) => {
  const roles = await tenantRoleService.listRoles({ tenantId: tenantOf(req) });
  return ApiResponse.ok(res, roles, 'Roles fetched');
});

export const listPermissionCatalogue = asyncHandler(async (req, res) => {
  const catalogue = await tenantRoleService.listPermissionCatalogue({ tenantId: tenantOf(req), actorId: actorOf(req) });
  return ApiResponse.ok(res, catalogue, 'Permissions fetched');
});

export const getRole = asyncHandler(async (req, res) => {
  const role = await tenantRoleService.getRole({ tenantId: tenantOf(req), roleId: req.validated.params.roleId });
  return ApiResponse.ok(res, role, 'Role fetched');
});

export const createRole = asyncHandler(async (req, res) => {
  const { name, description, permissions } = req.validated.body;
  const role = await tenantRoleService.createRole({
    tenantId: tenantOf(req), name, description, permissions, by: actorOf(req),
  });
  return ApiResponse.created(res, role, 'Role created');
});

export const updateRole = asyncHandler(async (req, res) => {
  const role = await tenantRoleService.updateRole({
    tenantId: tenantOf(req), roleId: req.validated.params.roleId, patch: req.validated.body ?? {}, by: actorOf(req),
  });
  return ApiResponse.ok(res, role, 'Role updated');
});

export const deleteRole = asyncHandler(async (req, res) => {
  const result = await tenantRoleService.deleteRole({
    tenantId: tenantOf(req), roleId: req.validated.params.roleId, by: actorOf(req),
  });
  return ApiResponse.ok(res, result, 'Role deleted');
});

/* ---------------------------- ownership / deletion ---------------------------- */

export const transferWorkspaceOwnership = asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const { userId, password } = req.validated.body;
  await verifyStepUp({ tenantId, userId: actorOf(req), password });
  const result = await transferOwnership({ tenantId, toUserId: userId, by: actorOf(req), actorType: 'user' });
  return ApiResponse.ok(res, {
    ownerId: result.newOwnerId,
    previousOwnerId: result.previousOwnerId,
  }, 'Ownership transferred');
});

export const getWorkspaceDeletion = asyncHandler(async (req, res) => {
  const context = await tenantDeletionService.getDeletionContext({ tenantId: tenantOf(req) });
  return ApiResponse.ok(res, context, 'Workspace deletion details');
});

export const requestWorkspaceDeletion = asyncHandler(async (req, res) => {
  const { confirm, password, reason } = req.validated.body;
  const deletion = await tenantDeletionService.requestDeletion({
    tenantId: tenantOf(req), by: actorOf(req), confirm, password, reason: reason ?? null,
  });
  return ApiResponse.accepted(res, deletion, 'Workspace scheduled for deletion');
});

export default {
  listMembers,
  getMember,
  setMemberRoles,
  deactivateMember,
  reactivateMember,
  removeMember,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  listRoles,
  listPermissionCatalogue,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  transferWorkspaceOwnership,
  getWorkspaceDeletion,
  requestWorkspaceDeletion,
};
