/**
 * Alert Evaluation Job (Sprint 7).
 *
 * Scans for enabled alert rules whose `nextEvaluationAt` is due, claims each
 * one atomically (advancing `nextEvaluationAt` in the same write) and
 * evaluates it (measure the metric per the alert metric contract, compare
 * the threshold, respect the cooldown, dispatch notifications), skipping
 * tenants that are not active. Every evaluation, including one suppressed
 * by the cooldown, moves the rule to its next cron slot. Driven every
 * minute by the scheduler under its distributed job lock.
 */

import * as alertService from '../services/alert.service.js';

export default {
  name: 'alert-evaluation',
  cronExpression: '* * * * *',
  enabled: true,
  // Returns { scanned, claimed, evaluated, triggered, suppressed, skippedInactive, failed };
  // the scheduler stores these counts on the job run.
  handler: async () => alertService.evaluateDue(),
};
