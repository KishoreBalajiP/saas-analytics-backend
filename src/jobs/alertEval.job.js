/**
 * Alert Evaluation Job (Sprint 7).
 *
 * Scans for enabled alert rules whose `nextEvaluationAt` is due and evaluates
 * each (aggregate metric, compare threshold, respect cooldown, dispatch
 * notifications). Driven every minute by the scheduler.
 */

import * as alertService from '../services/alert.service.js';

export default {
  name: 'alert-evaluation',
  cronExpression: '* * * * *',
  enabled: true,
  handler: async () => {
    await alertService.evaluateDue();
  },
};
