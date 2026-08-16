/**
 * Compliance Controller (Sprint 8 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/compliance`. Files and resolves GDPR /
 *   CCPA-style data-subject requests, and serves the subject-facing polling
 *   surface (signed token, no bearer credential).
 *
 * RESPONSIBILITY
 *   - admin: createRequest, listRequests, getRequest, cancelRequest
 *   - public: createSubjectRequest, getSubjectRequest
 *
 * CODING GUIDELINES
 *   - Internal routes require `adminAuth` + `permission('compliance', ...)`.
 *   - Tenant-scoped admins only see requests whose `tenantScope` includes
 *     their tenant; platform admins pass through.
 *   - External routes authenticate the caller with `authenticate` and let
 *     the subject act on their own identity only.
 *   - Every state transition emits an audit event (service layer).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import complianceService from '../services/compliance.service.js';
import * as storageService from '../services/storage.service.js';

/** Resolve the caller's tenant boundary (null = platform-wide). */
function boundary(req) {
  return req.admin?.tenantId ?? null;
}

/** Deny tenant-scoped callers access to requests outside their scope. */
function assertBoundary(row, tenantId) {
  if (tenantId && !(row.tenantScope ?? []).includes(tenantId)) {
    throw ApiError.notFound('Compliance request not found');
  }
}

/** POST /compliance/requests - file a request on behalf of a subject. */
export const createRequest = asyncHandler(async (req, res) => {
  const { subjectId, subjectType = 'user', type, reason, subjectEmail, tenantScope } = req.validated?.body ?? {};
  const result = await complianceService.fileRequest({
    subjectId,
    subjectType,
    type,
    reason,
    subjectEmail,
    tenantScope,
    requesterId: req.admin?.id ?? req.user?.id ?? null,
    requesterType: req.admin ? 'admin' : 'user',
    by: req.admin?.id ?? null,
  });
  return ApiResponse.accepted(res, result, 'Compliance request filed');
});

/** GET /compliance/requests - list + filter (admin surface). */
export const listRequests = asyncHandler(async (req, res) => {
  const { type, status, subjectId, subjectType, page, limit } = req.validated?.query ?? {};
  const tenantScope = boundary(req);
  const data = await complianceService.listRequests({
    filters: { type, status, subjectId, subjectType, tenantScope },
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, data.docs, 'Compliance requests fetched', {
    page: data.page,
    limit: data.limit,
    total: data.total,
    pages: data.pages,
  });
});

/** GET /compliance/requests/:id - status + evidence reference. */
export const getRequest = asyncHandler(async (req, res) => {
  const row = await complianceService.getRequestStatus({ requestId: req.params.id });
  assertBoundary(row, boundary(req));

  const out = { ...row };
  if (row.status === 'completed' && row.evidenceKey) {
    out.evidenceUrl = await storageService.presignedUrl(row.evidenceKey, { ttlSec: 60 * 60 });
  }
  return ApiResponse.ok(res, out, 'Compliance request');
});

/** POST /compliance/requests/:id/cancel - cancel before work starts. */
export const cancelRequest = asyncHandler(async (req, res) => {
  const row = await complianceService.getRequestStatus({ requestId: req.params.id });
  assertBoundary(row, boundary(req));

  const updated = await complianceService.cancelRequest({
    requestId: req.params.id,
    by: req.admin?.id ?? null,
    reason: req.validated?.body?.reason ?? 'Cancelled by administrator',
  });
  return ApiResponse.ok(res, { requestId: updated.requestId, status: updated.status }, 'Compliance request cancelled');
});

/** POST /compliance/public/requests - subject files a request for themselves. */
export const createSubjectRequest = asyncHandler(async (req, res) => {
  const actor = req.user;
  if (!actor) throw ApiError.unauthorized('Authentication required');

  const { type, reason } = req.validated?.body ?? {};
  const result = await complianceService.fileRequest({
    subjectId: actor.id,
    subjectType: 'user',
    type,
    reason,
    subjectEmail: actor.email ?? null,
    tenantScope: actor.tenantId ? [actor.tenantId] : [],
    requesterId: actor.id,
    requesterType: 'user',
  });
  const token = await complianceService.createSubjectToken({
    requestId: result.requestId,
    subjectId: actor.id,
  });
  return ApiResponse.accepted(res, { ...result, pollToken: token }, 'Compliance request filed');
});

/** GET /compliance/public/requests/:id - subject polls status via token. */
export const getSubjectRequest = asyncHandler(async (req, res) => {
  const { token } = req.validated?.query ?? {};
  const { subjectId } = await complianceService.verifySubjectToken({
    token,
    requestId: req.params.id,
  });
  const row = await complianceService.getRequestStatus({ requestId: req.params.id });
  if (row.subjectId !== subjectId) throw ApiError.notFound('Compliance request not found');
  return ApiResponse.ok(res, complianceService.toPublicStatus(row), 'Compliance request status');
});

export default {
  createRequest,
  listRequests,
  getRequest,
  cancelRequest,
  createSubjectRequest,
  getSubjectRequest,
};
