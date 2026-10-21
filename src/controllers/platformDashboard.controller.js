/**
 * Platform Dashboard Controller (Phase 5 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/admin/dashboard`. Surfaces the
 *   permission-filtered operational view consumed by the Platform Admin
 *   overview screen.
 */
import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import platformDashboardService from '../services/platformDashboard.service.js';
import { adminScopeOf } from '../middleware/adminScope.middleware.js';

const DEFAULT_RECENT_LIMIT = 10;

export const getSummary = asyncHandler(async (req, res) => {
  const limit = req.validated?.query?.limit ?? DEFAULT_RECENT_LIMIT;
  // A tenant-scoped admin gets a summary of its own tenant only.
  const summary = await platformDashboardService.getSummary({ recentLimit: limit, tenantId: adminScopeOf(req) });
  return ApiResponse.ok(res, summary, 'Dashboard summary fetched');
});

export default { getSummary };
