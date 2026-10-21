/**
 * Tenant purge job (roadmap 2.10, ten.14).
 *
 * WHY IT EXISTS
 *   A workspace whose deletion grace period ended must actually be deleted:
 *   every record in every collection listed in `tenantPurge.registry.js`
 *   and its stored files, followed by a verification count that is stored
 *   on the `TenantDeletion` record as evidence.
 *
 * RESPONSIBILITY
 *   `tenantDeletionService.runDuePurges()`: optionally schedule archived
 *   workspaces past their retention (`TENANT_PURGE_ARCHIVED_ENABLED`), then
 *   claim due deletions one at a time (atomic claim with a lease, so
 *   overlapping runs never purge the same tenant twice) and record each
 *   outcome. Runs under the scheduler's lock and records a JobRun.
 *
 * HOW TO EXTEND
 *   `JOB_TENANT_PURGE_CRON` / `JOB_TENANT_PURGE_ENABLED`. Disabled by
 *   default: review the pending deletions (GET /admin/tenant-deletions)
 *   before enabling it on the worker.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import tenantDeletionService from '../services/tenantDeletion.service.js';

export default {
  name: 'tenant-purge',
  cronExpression: env.members.jobs.tenantPurge.cron,
  enabled: env.members.jobs.tenantPurge.enabled,
  leaseMs: env.members.purgeLeaseMs,

  async handler() {
    const summary = await tenantDeletionService.runDuePurges();
    logger.info(summary, 'Tenant purge job executed');
    return summary;
  },
};
