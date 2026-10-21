/**
 * Scheduler claim helpers (roadmap 1.4).
 *
 * WHY IT EXISTS
 *   `report.service#runDue` and `alert.service#evaluateDue` both claim due
 *   items atomically (findOneAndUpdate that advances the next-run time and
 *   sets a lease) before acting, then skip tenants that are not active. This
 *   module holds the shared pieces so both scans behave identically.
 */

import { randomUUID } from 'node:crypto';
import schedulerConfig from '../config/scheduler.js';
import { nextCronDate } from '../utils/cron.js';
import { getInstanceId } from './runtime.js';

export { createTenantStatusCache, isTenantActive, TENANT_NOT_ACTIVE } from './tenantGuard.js';

/** Unique claim owner for one scan (instance id + random suffix). */
export function newClaimOwner() {
  return `${getInstanceId()}:${randomUUID()}`;
}

/** Lease held on a claimed item while this instance acts on it. */
export function claimLeaseMs() {
  return schedulerConfig.claimLeaseMs ?? 5 * 60 * 1000;
}

/**
 * Next run time for a stored cron, or `fallback` when the expression cannot
 * be parsed. Returns null when the cron never fires again.
 *
 * @param {string} cron
 * @param {Date} from
 * @param {string|null} [fallback] - cron used when `cron` is invalid.
 * @returns {Date|null}
 */
export function safeNextRun(cron, from, fallback = null) {
  try {
    return nextCronDate(cron, from);
  } catch {
    if (!fallback) return null;
    try { return nextCronDate(fallback, from); } catch { return null; }
  }
}

export default { newClaimOwner, claimLeaseMs, safeNextRun };
