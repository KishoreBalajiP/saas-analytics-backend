import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import invitationService from '../services/tenantInvitation.service.js';
import { getTenantId } from '../middleware/tenant.middleware.js';

export const preview = asyncHandler(async (req, res) => {
  const result = await invitationService.preview(req.validated?.query?.token ?? req.query.token);
  return ApiResponse.ok(res, result, 'Invitation fetched');
});

export const accept = asyncHandler(async (req, res) => {
  const result = await invitationService.accept(req.validated?.body ?? req.body);
  return ApiResponse.ok(res, result, 'Invitation accepted');
});

export const list = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.validated?.query ?? {};
  const result = await invitationService.list({ tenantId: req.params.id, status, page: page ?? 1, limit: limit ?? 20 });
  return ApiResponse.ok(res, result.docs, 'Invitations fetched', { page: result.page, limit: result.limit, total: result.total, pages: result.pages });
});

export const create = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const result = await invitationService.create({ tenantId: req.params.id, email: body.email, name: body.name, roleName: body.roleName ?? 'Owner', invitedBy: req.admin?.id });
  return result.delivered ? ApiResponse.created(res, result.invitation, 'Invitation sent') : ApiResponse.accepted(res, result.invitation, 'Invitation created but email delivery failed');
});

export const createForTenantUser = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const result = await invitationService.create({
    tenantId: getTenantId(req),
    email: body.email,
    name: body.name,
    roleName: body.roleName ?? 'Viewer',
    invitedBy: req.user?.id,
    actorType: 'user',
  });
  const data = {
    invitation: result.invitation,
    delivered: result.delivered,
    alreadyPending: result.alreadyPending ?? false,
  };
  if (result.alreadyPending) return ApiResponse.ok(res, data, 'Invitation already pending');
  return result.delivered
    ? ApiResponse.created(res, data, 'Invitation sent')
    : ApiResponse.accepted(res, data, 'Invitation created but email delivery failed');
});

export const resend = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const result = await invitationService.resend({
    tenantId: req.params.id,
    invitationId: body.invitationId,
    invitedBy: req.admin?.id,
  });
  return result.delivered ? ApiResponse.ok(res, result.invitation, 'Invitation resent') : ApiResponse.accepted(res, result.invitation, 'Invitation resent but email delivery failed');
});

export const revoke = asyncHandler(async (req, res) => {
  const result = await invitationService.revoke({ id: req.params.invitationId, tenantId: req.params.id, by: req.admin?.id });
  return ApiResponse.ok(res, result, 'Invitation revoked');
});

export default { preview, accept, list, create, createForTenantUser, resend, revoke };
