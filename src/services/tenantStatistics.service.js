/**
 * Tenant Statistics Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Composes the per-tenant activity numbers for the tenant statistics
 *   endpoint. The repository stays dumb; this service maps the counts into
 *   a single, stable response shape.
 *
 * RESPONSIBILITY
 *   - getStatistics({ tenantId }) -> { userCount, activeSessionCount,
 *       auditEventCount, lastActivityAt }
 *
 * CODING GUIDELINES
 *   - Reads only; never mutates tenant state.
 *   - Unknown tenants 404 so a typo in the route is visible immediately.
 *   - Dashboard/report counts land with those sprints (models are still
 *     placeholders); the audit-event count stands in for "activity".
 */

import ApiError from '../utils/ApiError.js';
import tenantRepository from '../repositories/tenant.repository.js';
import tenantStatisticsRepository from '../repositories/tenantStatistics.repository.js';

/**
 * Gather the statistics for a tenant.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @returns {Promise<Object>} statistics map.
 */
export async function getStatistics({ tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const [userCount, activeSessionCount, auditEventCount, lastActivityAt] = await Promise.all([
    tenantStatisticsRepository.countUsers(tenantId),
    tenantStatisticsRepository.countActiveSessions(tenantId),
    tenantStatisticsRepository.countAuditEvents(tenantId),
    tenantStatisticsRepository.lastActivityAt(tenantId),
  ]);

  return { userCount, activeSessionCount, auditEventCount, lastActivityAt };
}

export default {
  getStatistics,
  _meta: { tenancy: 'tenant', readsOnly: true },
};
