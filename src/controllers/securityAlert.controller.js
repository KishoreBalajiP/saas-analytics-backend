/**
 * Security Alert Controller (roadmap 2.6).
 *
 * Thin HTTP layer over `services/securityAlert.service.js`: parse validated
 * input, pass the acting admin (and its tenant scope), return the envelope.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import securityAlertService from '../services/securityAlert.service.js';

function requestMeta(req) {
  return { ip: req.ip ?? null, userAgent: req.headers?.['user-agent'] ?? null, requestId: req.id ?? null };
}

/** GET /admin/security-alerts */
export const listAlerts = asyncHandler(async (req, res) => {
  const { status, severity, ruleId, tenantId, search, from, to, page, limit } = req.validated?.query ?? {};
  const result = await securityAlertService.list({
    filters: { status, severity, ruleId, tenantId, search, from, to },
    page: page ?? 1,
    limit: limit ?? 20,
    tenantScope: req.admin?.tenantId ?? null,
  });
  return ApiResponse.ok(res, result.docs, 'Security alerts fetched', result.meta);
});

/** GET /admin/security-alerts/rules */
export const listRules = asyncHandler(async (_req, res) => {
  const rules = await securityAlertService.listRules();
  return ApiResponse.ok(res, rules, 'Detection rules fetched');
});

/** GET /admin/security-alerts/:id */
export const getAlert = asyncHandler(async (req, res) => {
  const alert = await securityAlertService.getById({ id: req.params.id, tenantScope: req.admin?.tenantId ?? null });
  return ApiResponse.ok(res, alert, 'Security alert fetched');
});

function transitionHandler(action, message) {
  return asyncHandler(async (req, res) => {
    const alert = await securityAlertService.transition({
      action,
      id: req.params.id,
      admin: req.admin,
      note: req.validated?.body?.note,
      request: requestMeta(req),
    });
    return ApiResponse.ok(res, alert, message);
  });
}

/** POST /admin/security-alerts/:id/acknowledge */
export const acknowledgeAlert = transitionHandler('acknowledge', 'Security alert acknowledged');
/** POST /admin/security-alerts/:id/false-positive */
export const markFalsePositive = transitionHandler('false_positive', 'Security alert marked as a false positive');
/** POST /admin/security-alerts/:id/resolve */
export const resolveAlert = transitionHandler('resolve', 'Security alert resolved');

export default { listAlerts, listRules, getAlert, acknowledgeAlert, markFalsePositive, resolveAlert };
