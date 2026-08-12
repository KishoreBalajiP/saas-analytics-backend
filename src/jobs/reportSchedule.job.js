/**
 * Report Schedule Job (Sprint 7).
 *
 * Scans for scheduled reports whose `nextRunAt` is due and enqueues a run for
 * each, then re-projects the next run time. Driven every minute by the
 * scheduler.
 */

import * as reportService from '../services/report.service.js';

export default {
  name: 'report-schedule',
  cronExpression: '* * * * *',
  enabled: true,
  handler: async () => {
    await reportService.runDue();
  },
};
