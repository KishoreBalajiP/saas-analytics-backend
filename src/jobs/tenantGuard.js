/**
 * Tenant guard for background work (roadmap 1.6, scheduler side) and for
 * connector ingestion (connector side of 1.6).
 *
 * WHY IT EXISTS
 *   A suspended, disabled, archived (or deleted) tenant must stop producing
 *   scheduled reports, alert notifications and connector syncs immediately,
 *   not when its schedules are next edited. Every background executor asks
 *   this module at EXECUTION time, so work queued before a suspension is
 *   skipped too. Connector ingestion (manual syncs, webhooks, the sync
 *   worker) uses the same check at request and execution time.
 *
 * POLICY
 *   Only `status === 'active'` runs. A tenant that cannot be found (deleted,
 *   malformed id) is treated as not active. A lookup that FAILS (database
 *   unavailable) depends on the caller:
 *     - `onLookupError: 'inactive'` (default; scheduler, analytics worker,
 *       reaper): background work fails closed and is skipped.
 *     - `onLookupError: 'throw'` (connector requests and the sync worker): the
 *       error propagates, so a request fails with 5xx and a queued sync is
 *       retried instead of being skipped as if the workspace were suspended.
 */

import tenantRepository from '../repositories/tenant.repository.js';
import logger from '../utils/logger.js';

/** Machine code recorded on skipped runs. */
export const TENANT_NOT_ACTIVE = 'TENANT_NOT_ACTIVE';

/**
 * Is the tenant allowed to run background work right now?
 *
 * @param {string} tenantId
 * @param {Object} [options]
 * @param {'inactive'|'throw'} [options.onLookupError='inactive'] - what a
 *   failed lookup (not a malformed id) means: not active, or rethrow.
 * @returns {Promise<boolean>}
 */
export async function isTenantActive(tenantId, { onLookupError = 'inactive' } = {}) {
  if (!tenantId) return false;
  try {
    const tenant = await tenantRepository.findById(String(tenantId));
    return tenant?.status === 'active';
  } catch (err) {
    // A malformed id is never an active tenant.
    if (err?.name === 'CastError') return false;
    if (onLookupError === 'throw') throw err;
    // Transient read failure: background work fails closed and is skipped.
    logger.debug({ err: { message: err?.message }, tenantId }, 'tenant status lookup failed');
    return false;
  }
}

/**
 * Memoised `isTenantActive` for one scheduler tick, so a tenant with many due
 * items is looked up once.
 *
 * @returns {(tenantId: string) => Promise<boolean>}
 */
export function createTenantStatusCache() {
  const cache = new Map();
  return (tenantId) => {
    const key = String(tenantId ?? '');
    if (!cache.has(key)) cache.set(key, isTenantActive(key));
    return cache.get(key);
  };
}

export default { isTenantActive, createTenantStatusCache, TENANT_NOT_ACTIVE };
