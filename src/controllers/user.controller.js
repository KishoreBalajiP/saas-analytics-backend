/**
 * User Controller (Sprint 2 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/users`. Tenant-scoped: the tenant always
 *   comes from the authenticated token, never from the body or params.
 *
 * RESPONSIBILITY
 *   - me         - the caller's own profile
 *   - updateMe   - edit own profile fields
 *   - list       - tenant-scoped paginated list (tenant-admin surface)
 *   - getById    - tenant-scoped detail
 *
 * CODING GUIDELINES
 *   - Handlers are thin; `services/user.service.js` owns all logic.
 *   - Secrets (passwordHash, lockout counters) never leave the service.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import userService from '../services/user.service.js';

/** GET /users/me - the caller's own profile. */
export const me = asyncHandler(async (req, res) => {
  const user = await userService.getProfile({ userId: req.user.id });
  return ApiResponse.ok(res, user, 'Profile fetched');
});

/** PATCH /users/me - edit own profile fields. */
export const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile({
    userId: req.user.id,
    patch: req.validated?.body ?? {},
  });
  return ApiResponse.ok(res, user, 'Profile updated');
});

/** GET /users - tenant-scoped paginated list. */
export const list = asyncHandler(async (req, res) => {
  const { search, page, limit } = req.validated?.query ?? {};
  const result = await userService.list({
    tenantId: req.user.tenantId,
    search,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Users fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /users/:userId - tenant-scoped user detail. */
export const getById = asyncHandler(async (req, res) => {
  const user = await userService.getById({
    id: req.params.userId,
    tenantId: req.user.tenantId,
  });
  return ApiResponse.ok(res, user, 'User fetched');
});

export default { me, updateMe, list, getById };
