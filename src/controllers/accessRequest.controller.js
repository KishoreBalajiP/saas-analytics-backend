import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import service from '../services/accessRequest.service.js';

export const submit = asyncHandler(async (req, res) => ApiResponse.accepted(res, await service.submit(req.validated.body), 'Request received'));
export const list = asyncHandler(async (req, res) => {
  await service.assertPlatformAdmin?.(req.admin);
  const result = await service.list(req.validated.query);
  return ApiResponse.ok(res, result.docs, 'Access requests fetched', { page: result.page, limit: result.limit, total: result.total, pages: result.pages });
});
export const approve = asyncHandler(async (req, res) => ApiResponse.ok(res, await service.approve({ ...req.validated.body, id: req.validated.params.id, admin: req.admin }), 'Access request approved'));
export const reject = asyncHandler(async (req, res) => ApiResponse.ok(res, await service.reject({ ...req.validated.body, id: req.validated.params.id, admin: req.admin }), 'Access request rejected'));
export default { submit, list, approve, reject };
