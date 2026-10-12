/**
 * Platform Admin Dashboard Service (Phase 5 - implemented).
 *
 * PURPOSE
 *   Real-data aggregation for the Platform Admin overview. Every value
 *   is sourced from authoritative server-side stores (Tenant counts,
 *   AuditLog entries, Monitoring aggregate). No fabricated health.
 *
 * RESPONSIBILITY
 *   - getSummary({ recentLimit }) -> { counts, recentTenants, recentActions }
 *   - getRecentTenants({ limit })
 *   - getRecentActions({ limit })
 *
 * CODING GUIDELINES
 *   - Bounded queries: limit is clamped to a safe maximum so deep links
 *     and dashboards cannot fan out into expensive scans.
 *   - Recent action results expose only the audit-log public shape
 *     (already redacted; never includes raw secrets or tokens).
 *   - Health is delegated to the monitoring service; this module never
 *     inspects env vars or config to "imply" health.
 */
import tenantRepository from '../repositories/tenant.repository.js';
import auditLogRepository from '../repositories/auditLog.repository.js';
import { getAggregateHealth } from './monitoring.service.js';

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 25;

function clampLimit(value, fallback = DEFAULT_RECENT_LIMIT) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_RECENT_LIMIT);
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.recentLimit=10]
 * @returns {Promise<{ counts: Object, recentTenants: Object[], recentActions: Object[], health: Object, generatedAt: string }>}
 */
export const getSummary = async ({ recentLimit = DEFAULT_RECENT_LIMIT } = {}) => {
  const limit = clampLimit(recentLimit);
  const [counts, recentTenants, recentActions, health] = await Promise.all([
    getTenantCounts(),
    getRecentTenants({ limit }),
    getRecentActions({ limit }),
    safeHealth(),
  ]);
  return { counts, recentTenants, recentActions, health, generatedAt: new Date().toISOString() };
};

async function getTenantCounts() {
  const statuses = ['pending', 'active', 'suspended', 'disabled', 'archived'];
  const results = await Promise.all(statuses.map((s) => tenantRepository.countByStatus(s)));
  const counts = { total: 0 };
  statuses.forEach((status, idx) => {
    counts[status] = results[idx];
    counts.total += results[idx];
  });
  return counts;
}

async function getRecentTenants({ limit }) {
  const result = await tenantRepository.list({ page: 1, limit, sort: { createdAt: -1 } });
  return (result.docs ?? []).map(safeTenantProjection);
}

function safeTenantProjection(tenant) {
  if (!tenant) return tenant;
  const { _id, name, slug, status, createdAt, updatedAt } = tenant;
  return { id: String(_id), name, slug, status, createdAt, updatedAt };
}

async function getRecentActions({ limit }) {
  const result = await auditLogRepository.list({ filter: {}, page: 1, limit });
  return (result.docs ?? []).map((entry) => ({
    id: String(entry._id),
    module: entry.module,
    action: entry.action,
    resourceId: entry.resourceId ? String(entry.resourceId) : null,
    actor: entry.actor
      ? {
          id: entry.actor.id ? String(entry.actor.id) : null,
          type: entry.actor.type ?? 'system',
        }
      : null,
    occurredAt: entry.occurredAt,
  }));
}

async function safeHealth() {
  try {
    return await getAggregateHealth();
  } catch (err) {
    return { status: 'unknown', message: 'monitoring unavailable' };
  }
}

export default { getSummary, getRecentTenants, getRecentActions };
