/**
 * Security detection job (roadmap 2.6, document 11 section 4).
 *
 * WHY IT EXISTS
 *   Platform security events (failed sign-ins, privilege changes, MFA
 *   changes, impersonation, API-key misuse, denied requests, exports,
 *   connector authentication failures, resource pressure) must raise
 *   alerts someone acts on, not only sit in the stores.
 *
 * RESPONSIBILITY
 *   Run `securityDetection/engine.runDetection()` on its cron. The scheduler
 *   runs it under the distributed job lock and records a JobRun with the
 *   counters returned here (rules evaluated, detections, alerts raised /
 *   merged / suppressed, notifications). Each rule keeps its own watermark,
 *   so a tick only reads events it has not evaluated yet.
 *   A rule that fails keeps its watermark (retried next tick); the run is
 *   then marked failed so monitoring shows it, after the other rules ran.
 *
 * HOW TO EXTEND
 *   - Cron / switch: JOB_SECURITY_DETECTION_CRON, JOB_SECURITY_DETECTION_ENABLED.
 *   - Rules and thresholds: services/securityDetection/rules/,
 *     SECURITY_DETECTION_RULES_JSON, platform setting `security.detection.rules`.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import { runDetection } from '../services/securityDetection/engine.js';
import { flush as flushSignals } from '../services/securityDetection/signals.js';

export const JOB_NAME = 'security-detection';

export async function handler() {
  // Counters recorded by this process are written before evaluating.
  await flushSignals().catch(() => 0);
  const summary = await runDetection();
  const { results, ...counts } = summary;
  logger.info({ ...counts }, 'Security detection job executed');
  if (counts.failed > 0) {
    const failed = results.filter((r) => r.status === 'failed').map((r) => r.ruleId);
    const err = new Error(`${counts.failed} detection rule(s) failed: ${failed.join(', ')}`);
    err.code = 'DETECTION_RULE_FAILED';
    throw err;
  }
  return counts;
}

export default {
  name: JOB_NAME,
  cronExpression: env.securityDetection.cron,
  enabled: env.securityDetection.enabled,
  handler,
};
