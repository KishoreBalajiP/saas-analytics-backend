/**
 * Analytics Worker (Sprint 7; roadmap 1.5).
 *
 * WHY IT EXISTS
 *   The analytics queue (`ANALYTICS_JOBS`) carries report runs, alert
 *   evaluations and async analytics exports. This module registers the
 *   single combined consumer for that queue and dispatches by job `type`.
 *
 * RESPONSIBILITY
 *   - `report`  -> `report.service.processRun` (generate artefact + persist)
 *   - `alert`   -> `alert.service.evaluate` (threshold check + notify)
 *   - `export`  -> `analyticsExport.service.processExport` (stream the whole
 *                  query result into storage; status `ready` or `failed`)
 *
 * Errors are swallowed per-job so one bad job never kills the consumer.
 * Jobs for a tenant that is no longer active are skipped at execution time
 * (a report run or export is marked failed with the reason).
 */

import logger from '../utils/logger.js';
import * as queueService from '../services/queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import * as reportService from '../services/report.service.js';
import * as alertService from '../services/alert.service.js';
import * as analyticsExportService from '../services/analyticsExport.service.js';
import reportRepository from '../repositories/report.repository.js';
import { isTenantActive } from './tenantGuard.js';

const TENANT_JOB_TYPES = new Set(['report', 'alert', 'export']);
const INACTIVE_REASON = 'Skipped: the workspace is not active';

/**
 * Handle one analytics job (exported for tests; the queue consumer calls it).
 *
 * @param {{ data?: { type?: string, tenantId?: string, params?: object } }} job
 */
export async function handleAnalyticsJob(job) {
  const { type, tenantId, params } = job?.data || {};
  try {
    // Re-check the tenant at execution time: work queued before a
    // suspension must not run after it.
    if (TENANT_JOB_TYPES.has(type) && !(await isTenantActive(tenantId))) {
      if (type === 'report' && params?.reportId && params?.runId) {
        await reportRepository.completeRun(params.reportId, params.runId, {
          status: 'failed', finishedAt: new Date(), error: INACTIVE_REASON,
        });
      } else if (type === 'export' && params?.exportId) {
        await analyticsExportService.skipExport({ tenantId, exportId: params.exportId, reason: INACTIVE_REASON });
      }
      logger.info({ type, tenantId }, 'analytics job skipped: tenant not active');
      return;
    }
    if (type === 'report') {
      await reportService.processRun({ tenantId, ...(params || {}) });
    } else if (type === 'alert') {
      await alertService.evaluate({ tenantId, ...(params || {}) });
    } else if (type === 'export') {
      const outcome = await analyticsExportService.processExport({ tenantId, exportId: params?.exportId });
      logger.info({ tenantId, exportId: params?.exportId, status: outcome?.status }, 'analytics export job completed');
    } else {
      logger.warn({ type }, 'analytics job type not handled by worker');
    }
  } catch (err) {
    logger.error({ err: { message: err?.message }, type }, 'analytics job failed');
  }
}

let registered = false;

/**
 * Register the analytics queue consumer exactly once per process.
 */
export function registerAnalyticsWorker() {
  if (registered) return;
  registered = true;
  queueService.registerConsumer(QUEUE_NAMES.ANALYTICS_JOBS, handleAnalyticsJob);
}

export default { registerAnalyticsWorker, handleAnalyticsJob };
