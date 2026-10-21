/** Insight controller (ai-insights): /api/v1/insights. */
import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import insightService from '../services/insights/insight.service.js';

const actorOf = (req) => req.user?.id ?? null;

export const list = asyncHandler(async (req, res) => {
  const q = req.validated?.query ?? {};
  const r = await insightService.list({ tenantId: getTenantId(req), dashboardId: q.dashboardId, metricKey: q.metric, status: q.status ?? 'open', page: q.page ?? 1, limit: q.limit ?? 20 });
  return ApiResponse.ok(res, r.docs, 'Insights', { page: r.page, limit: r.limit, total: r.total, pages: r.pages });
});
export const generate = asyncHandler(async (req, res) => ApiResponse.created(res, await insightService.generate({ tenantId: getTenantId(req), actorId: actorOf(req), input: req.body }), 'Insights generated'));
export const dismiss = asyncHandler(async (req, res) => ApiResponse.ok(res, await insightService.dismiss({ tenantId: getTenantId(req), id: req.validated.params.id, actorId: actorOf(req) }), 'Insight dismissed'));
export const feedback = asyncHandler(async (req, res) => ApiResponse.ok(res, await insightService.feedback({ tenantId: getTenantId(req), id: req.validated.params.id, actorId: actorOf(req), rating: req.validated.body.rating }), 'Feedback recorded'));

export default { list, generate, dismiss, feedback };
