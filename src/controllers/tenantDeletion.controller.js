/**
 * Tenant Deletion Controller - platform admin side (roadmap 2.10, ten.14).
 *
 * Platform admins see pending and past workspace deletions and can cancel a
 * scheduled one during its grace period. Owners request deletion through
 * `/workspace/deletion` (workspaceMembers.controller.js).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import tenantDeletionService from '../services/tenantDeletion.service.js';

const adminOf = (req) => req.admin?.id ?? null;

/** GET /admin/tenant-deletions */
export const listDeletions = asyncHandler(async (req, res) => {
  const { status, tenantId, page, limit } = req.validated?.query ?? {};
  const result = await tenantDeletionService.listDeletions({ status, tenantId, page: page ?? 1, limit: limit ?? 20 });
  return ApiResponse.ok(res, result.docs, 'Tenant deletions fetched', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** GET /tenants/:id/deletion - the latest deletion record (or null). */
export const getDeletion = asyncHandler(async (req, res) => {
  const deletion = await tenantDeletionService.getDeletion({ tenantId: req.validated.params.id });
  return ApiResponse.ok(res, deletion, deletion ? 'Tenant deletion fetched' : 'No deletion recorded');
});

/** POST /tenants/:id/deletion/cancel */
export const cancelDeletion = asyncHandler(async (req, res) => {
  const deletion = await tenantDeletionService.cancelDeletion({
    tenantId: req.validated.params.id,
    by: adminOf(req),
    reason: req.validated.body?.reason ?? null,
    actorType: 'admin',
  });
  return ApiResponse.ok(res, deletion, 'Tenant deletion cancelled');
});

export default { listDeletions, getDeletion, cancelDeletion };
