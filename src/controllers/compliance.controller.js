/**
 * Compliance Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/compliance`. Files and resolves GDPR /
 *   CCPA-style data-subject requests.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - admin: createRequest, listRequests, getRequest, cancelRequest
 *   - public: createSubjectRequest, getSubjectRequest
 *
 * CODING GUIDELINES
 *   - Internal routes require `modulePermission('compliance', ...)`.
 *   - External routes authenticate via a signed subject token (no JWT).
 *   - Every state transition emits an audit event.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const createRequest = notImplemented('POST /compliance/requests');
export const listRequests = notImplemented('GET /compliance/requests');
export const getRequest = notImplemented('GET /compliance/requests/:id');
export const cancelRequest = notImplemented('POST /compliance/requests/:id/cancel');
export const createSubjectRequest = notImplemented('POST /compliance/public/requests');
export const getSubjectRequest = notImplemented('GET /compliance/public/requests/:id');

export default {
  createRequest, listRequests, getRequest, cancelRequest,
  createSubjectRequest, getSubjectRequest,
};
