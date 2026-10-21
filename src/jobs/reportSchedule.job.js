/**
 * Report Schedule Job (Sprint 7).
 *
 * Scans for scheduled reports whose `nextRunAt` is due, claims each one
 * atomically (advancing `nextRunAt` in the same write) and enqueues one run
 * per claim, skipping tenants that are not active. Driven every minute by
 * the scheduler under its distributed job lock.
 */

import * as reportService from '../services/report.service.js';

export default {
  name: 'report-schedule',
  cronExpression: '* * * * *',
  enabled: true,
  // Returns { scanned, claimed, enqueued, skippedInactive, failed }; the
  // scheduler stores these counts on the job run.
  handler: async () => reportService.runDue(),
};
