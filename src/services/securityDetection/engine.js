/**
 * Security detection engine (roadmap 2.6, document 11 section 4).
 *
 * WHAT IT DOES
 *   Runs every enabled rule (rules/index.js) incrementally and turns its
 *   detections into `SecurityAlert` records:
 *     1. per rule, read the watermark (`SecurityDetectionCursor`); the first
 *        run looks back SECURITY_DETECTION_INITIAL_LOOKBACK_MINUTES, and
 *        after downtime the catch-up is capped at
 *        SECURITY_DETECTION_MAX_CATCHUP_HOURS (the skipped span is logged);
 *     2. evaluate events in (watermark, now - settle - rule lag], in slices
 *        of at most SLICE_MS so memory stays bounded;
 *     3. raise each detection (below), then advance the watermark to the
 *        slice end. A rule that throws keeps its watermark (the slice is
 *        retried next run) and records the error on its cursor.
 *
 * RAISING A DETECTION
 *   dedupe key = `<rule id>|<subject type>:<subject id>[|<rule suffix>]`
 *   - an ACTIVE (open/acknowledged) alert with that key exists: merge into
 *     it (occurrences, last seen, window, newest evidence; severity only
 *     ever escalates). There is never a second active alert per key (unique
 *     partial index).
 *   - the key's last alert was closed as a false positive within
 *     SECURITY_ALERT_FALSE_POSITIVE_SUPPRESS_HOURS: suppressed.
 *   - otherwise a new `open` alert is created (security event
 *     SECURITY_ALERT_RAISED).
 *   Alerts at or above SECURITY_ALERT_NOTIFY_MIN_SEVERITY (on creation or on
 *   escalation) notify the on-call targets once (notifier.js).
 *
 * Re-running a slice after a crash can only merge into the alert the first
 * attempt created; it can never duplicate it.
 */

import { createHash } from 'node:crypto';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import clock from '../../utils/clock.js';
import { sanitizeError } from '../../utils/sanitizeError.js';
import securityAlertRepository from '../../repositories/securityAlert.repository.js';
import securityDetectionCursorRepository from '../../repositories/securityDetectionCursor.repository.js';
import securitySignalRepository from '../../repositories/securitySignal.repository.js';
import securityDetectionSourceRepository from '../../repositories/securityDetectionSource.repository.js';
import { SEVERITY_RANK, ALERT_SEVERITIES } from '../../models/SecurityAlert.js';
import { securityEvent } from '../securityEvent.service.js';
import queueService from '../queue.service.js';
import { QUEUE_NAMES } from '../../queues/constants.js';
import { RULES } from './rules/index.js';
import { resolveRuleConfigs } from './config.js';
import { notifyAlert, notifyThresholdRank } from './notifier.js';
import { MINUTE_MS, HOUR_MS } from './util.js';

/** Largest span one rule evaluates in a single pass. */
export const SLICE_MS = 60 * MINUTE_MS;
const MAX_DEDUPE_KEY = 400;

function settings() {
  return env.securityDetection ?? {};
}

/** Stable dedupe key for a detection (hashed when very long). */
export function dedupeKeyFor(rule, detection) {
  const subject = detection.subject ?? {};
  const raw = [rule.id, `${subject.type}:${subject.id}`, detection.dedupe].filter(Boolean).join('|');
  if (raw.length <= MAX_DEDUPE_KEY) return raw;
  return `${rule.id}|sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function severityOf(rule, detection) {
  const severity = ALERT_SEVERITIES.includes(detection.severity) ? detection.severity : rule.severity;
  return { severity, severityRank: SEVERITY_RANK[severity] };
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

/** Default event-source bundle handed to every rule (tests inject their own). */
export function defaultSources() {
  return {
    sources: securityDetectionSourceRepository,
    signals: securitySignalRepository,
    queueStats: () => queueService.getQueueStats({ timeoutMs: 2000, ensureNames: Object.values(QUEUE_NAMES) }),
  };
}

/**
 * Create or merge one detection.
 *
 * @returns {Promise<{ outcome: 'raised'|'merged'|'suppressed', alert: Object|null, notified: boolean }>}
 */
export async function raiseDetection(rule, detection, { now = clock.now(), notify = true } = {}) {
  const dedupeKey = dedupeKeyFor(rule, detection);
  const { severity, severityRank } = severityOf(rule, detection);
  const lastSeenAt = new Date(detection.windowEnd ?? now);
  const windowStart = detection.windowStart ? new Date(detection.windowStart) : lastSeenAt;
  const refs = (detection.refs ?? []).slice(-50);
  const notifyRank = notifyThresholdRank();

  const merge = async () => {
    const before = await securityAlertRepository.mergeIntoActive(dedupeKey, {
      lastSeenAt,
      windowStart,
      windowEnd: lastSeenAt,
      severity,
      severityRank,
      counts: detection.counts ?? null,
      details: detection.details ?? null,
      refs,
      history: { at: now, action: 'merged', by: null, note: clip(detection.summary, 500) || null },
    });
    if (!before) return null;
    let notified = false;
    if (severityRank > before.severityRank) {
      await securityAlertRepository.appendHistory(before._id, {
        at: now, action: 'escalated', by: null, from: before.severity, to: severity, note: null,
      });
      if (notify && severityRank >= notifyRank && !before.notifiedAt) {
        const current = await securityAlertRepository.findById(before._id);
        if (current) notified = (await notifyAlert(current, { now })).notified;
      }
    }
    return { outcome: 'merged', alert: before, notified };
  };

  const existing = await securityAlertRepository.findActiveByKey(dedupeKey);
  if (existing) {
    const merged = await merge();
    if (merged) return merged;
  }

  const suppressHours = Number(settings().falsePositiveSuppressHours ?? 0);
  if (suppressHours > 0) {
    const dismissed = await securityAlertRepository.findRecentlyClosed({
      dedupeKey,
      status: 'false_positive',
      since: new Date(now.getTime() - suppressHours * HOUR_MS),
    });
    if (dismissed) return { outcome: 'suppressed', alert: dismissed, notified: false };
  }

  const created = await securityAlertRepository.createActive({
    ruleId: rule.id,
    ruleVersion: rule.version,
    title: clip(detection.title ?? rule.title, 200),
    summary: clip(detection.summary, 1000),
    severity,
    severityRank,
    dedupeKey,
    subject: {
      type: clip(detection.subject?.type ?? 'unknown', 40),
      id: clip(detection.subject?.id ?? 'unknown', 200),
      display: detection.subject?.display ? clip(detection.subject.display, 300) : null,
    },
    tenantId: detection.tenantId ? String(detection.tenantId) : null,
    firstSeenAt: windowStart,
    lastSeenAt,
    windowStart,
    windowEnd: lastSeenAt,
    occurrences: 1,
    evidence: { counts: detection.counts ?? null, details: detection.details ?? null, refs },
    history: [{ at: now, action: 'raised', by: null, note: null }],
  });
  if (!created) {
    // Another run created it between our read and insert: merge instead.
    const merged = await merge();
    return merged ?? { outcome: 'merged', alert: null, notified: false };
  }

  await securityEvent('SECURITY_ALERT_RAISED', {
    actor: { type: 'system', id: null, display: 'security-detection' },
    tenantId: created.tenantId ?? null,
    resource: { type: 'security_alert', id: String(created._id) },
    metadata: {
      alertId: String(created._id),
      ruleId: rule.id,
      ruleVersion: rule.version,
      severity,
      subject: created.subject,
    },
  });

  let notified = false;
  if (notify && severityRank >= notifyRank) notified = (await notifyAlert(created, { now })).notified;
  return { outcome: 'raised', alert: created, notified };
}

/**
 * Evaluate the rules once (the detector job's handler).
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {Array} [options.rules] - defaults to the full catalogue.
 * @param {Object} [options.context] - event sources (tests inject).
 * @param {Object} [options.settingOverrides] - rule overrides instead of the platform setting.
 * @param {boolean} [options.notify=true]
 * @returns {Promise<Object>} counters (stored on the job run) and per-rule results.
 */
export async function runDetection({
  now = clock.now(),
  rules = RULES,
  context = defaultSources(),
  settingOverrides,
  notify = true,
} = {}) {
  const cfg = settings();
  const configs = await resolveRuleConfigs(rules, settingOverrides === undefined ? {} : { settingOverrides });
  const summary = {
    rules: rules.length, evaluated: 0, disabled: 0, failed: 0, detections: 0, raised: 0, merged: 0, suppressed: 0, notified: 0,
  };
  const results = [];
  const settleMs = Math.max(0, Number(cfg.settleSec ?? 60)) * 1000;
  const initialMs = Math.max(1, Number(cfg.initialLookbackMinutes ?? 60)) * MINUTE_MS;
  const maxCatchUpMs = Math.max(1, Number(cfg.maxCatchUpHours ?? 24)) * HOUR_MS;

  for (const rule of rules) {
    const { config } = configs.get(rule.id) ?? { config: { ...rule.defaults } };
    if (config.enabled === false) {
      summary.disabled += 1;
      results.push({ ruleId: rule.id, status: 'disabled' });
      continue;
    }
    const to = new Date(now.getTime() - settleMs - (rule.lagMs ?? 0));
    let detections = 0;
    try {
      const cursor = await securityDetectionCursorRepository.get(rule.id);
      let from = cursor?.watermark ? new Date(cursor.watermark) : new Date(to.getTime() - initialMs);
      const floor = new Date(to.getTime() - maxCatchUpMs);
      if (from < floor) {
        logger.warn({ rule: rule.id, from, floor }, '[security-detection] catch-up capped; older events not evaluated');
        from = floor;
      }
      if (from >= to) {
        results.push({ ruleId: rule.id, status: 'up_to_date' });
        summary.evaluated += 1;
        continue;
      }
      for (let sliceFrom = from; sliceFrom < to;) {
        const sliceTo = new Date(Math.min(to.getTime(), sliceFrom.getTime() + SLICE_MS));
        const found = await rule.evaluate({
          from: sliceFrom,
          to: sliceTo,
          now,
          config,
          finalSlice: sliceTo.getTime() === to.getTime(),
          apiPrefix: env.app.apiPrefix,
          ...context,
        });
        for (const detection of found ?? []) {
          const result = await raiseDetection(rule, detection, { now, notify });
          detections += 1;
          summary[result.outcome] += 1;
          if (result.notified) summary.notified += 1;
        }
        await securityDetectionCursorRepository.advance(rule.id, {
          watermark: sliceTo, ruleVersion: rule.version, lastRunAt: now, detections,
        });
        sliceFrom = sliceTo;
      }
      summary.evaluated += 1;
      summary.detections += detections;
      results.push({ ruleId: rule.id, status: 'ok', detections });
    } catch (err) {
      summary.failed += 1;
      summary.detections += detections;
      const safe = sanitizeError(err);
      logger.error({ err: { message: err?.stack ?? err?.message }, rule: rule.id }, '[security-detection] rule evaluation failed');
      await securityDetectionCursorRepository
        .recordError(rule.id, { lastRunAt: now, message: safe?.message ?? 'Rule evaluation failed', ruleVersion: rule.version })
        .catch(() => {});
      results.push({ ruleId: rule.id, status: 'failed', error: safe?.message ?? 'failed' });
    }
  }
  return { ...summary, results };
}

export default { runDetection, raiseDetection, dedupeKeyFor, defaultSources, SLICE_MS };
