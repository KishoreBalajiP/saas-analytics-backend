/**
 * Tenant export expiry job (roadmap 2.9).
 *
 * WHY IT EXISTS
 *   A tenant data export archive holds every record a workspace owns, so it
 *   must not outlive its download window. Downloads already stop at
 *   `expiresAt`; this sweep deletes the archive from storage and marks the
 *   export `expired`. It also fails exports that were never picked up or
 *   whose worker died (lease lapsed), so a workspace is never blocked from
 *   requesting a new export.
 *
 * RESPONSIBILITY
 *   Run `tenantExportService.sweep()` hourly (bounded batches; the next run
 *   continues). Registered with the scheduler, so it runs under the job lock
 *   and records a JobRun. Configure an S3 lifecycle rule on the
 *   `storage/tenant-exports/` prefix as a second line of defence.
 *
 * HOW TO EXTEND
 *   `JOB_TENANT_EXPORT_EXPIRY_CRON`, `JOB_TENANT_EXPORT_EXPIRY_ENABLED`.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import tenantExportService from '../services/tenantExport.service.js';

export default {
  name: 'tenant-export-expiry',
  cronExpression: env.tenantExport.expiryJob.cron,
  enabled: env.tenantExport.expiryJob.enabled,

  async handler() {
    const summary = await tenantExportService.sweep({ limit: 200 });
    logger.info(summary, 'Tenant export expiry job executed');
    return summary;
  },
};
