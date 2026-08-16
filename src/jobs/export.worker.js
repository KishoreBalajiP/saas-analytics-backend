/**
 * Export Worker (Sprint 8).
 *
 * WHY IT EXISTS
 *   The export queue (`EXPORT_JOBS`) materialises export artifacts. This
 *   module registers the single consumer for that queue and dispatches to the
 *   right materialiser based on the row's `kind`:
 *
 *     - `audit`       -> `auditExport.service#processExport` (audit trail)
 *     - `access-log`  -> `accessLog.service#processExport` (HTTP access trace)
 *     - `compliance`  -> `compliance.service#COMPLIANCE_PROCESSORS[type]`
 *                        (data-subject request fulfillment)
 *
 *   Errors are logged and swallowed per-job (the service marks the row
 *   `failed` where applicable), so one bad export never kills the consumer.
 *
 * HOW TO EXTEND
 *   Add new export kinds here as the platform grows.
 */

import logger from '../utils/logger.js';
import * as queueService from '../services/queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import * as auditExportService from '../services/auditExport.service.js';
import * as accessLogService from '../services/accessLog.service.js';
import * as complianceService from '../services/compliance.service.js';

let registered = false;

/**
 * Register the export queue consumer exactly once per process.
 */
export function registerExportWorker() {
  if (registered) return;
  registered = true;
  queueService.registerConsumer(QUEUE_NAMES.EXPORT_JOBS, async (job) => {
    const { exportId, kind, type, requestId } = job?.data || {};
    try {
      let summary;
      if (kind === 'compliance') {
        const processor = complianceService.COMPLIANCE_PROCESSORS[type];
        if (!processor) throw new Error(`Unknown compliance job type "${type}"`);
        summary = await processor({ requestId });
      } else {
        summary = kind === 'access-log'
          ? await accessLogService.processExport({ exportId })
          : await auditExportService.processExport({ exportId });
      }
      logger.info({ requestId, exportId, kind: kind ?? 'audit', status: summary?.status }, 'export job completed');
    } catch (err) {
      logger.error({ err: { message: err?.message }, requestId, exportId, kind: kind ?? 'audit', type }, 'export job failed');
    }
  });
}

export default { registerExportWorker };
