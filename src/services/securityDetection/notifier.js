/**
 * On-call notifier for security alerts (roadmap 2.6).
 *
 * WHY IT EXISTS
 *   High-severity detections must reach a person, not only the admin
 *   console. Alerts at or above SECURITY_ALERT_NOTIFY_MIN_SEVERITY are sent
 *   once (an atomic claim on the alert) to the on-call targets from
 *   `config.js#resolveNotificationTargets`.
 *
 * PLUGGABLE SINKS
 *   Each channel is a sink `async ({ alert, message, payload, targets }) =>
 *   { id, status }`. The defaults go through the delivery pipeline contract
 *   (`services/delivery/index.js#deliver`): `email` (on-call addresses, via
 *   the email outbox) and `webhook` (generic JSON POST, signed and
 *   egress-checked by the pipeline). Tests replace them with capture sinks
 *   (`setNotificationSinks`), so no test touches the network.
 *
 * WHAT IS SENT
 *   Rule, severity, title, summary, subject, counts, timestamps and a link to
 *   the admin console. Never evidence rows, credentials or webhook URLs;
 *   the alert records the email recipients and the webhook ORIGIN only.
 */

import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import clock from '../../utils/clock.js';
import { deliver } from '../delivery/index.js';
import { securityEvent } from '../securityEvent.service.js';
import securityAlertRepository from '../../repositories/securityAlert.repository.js';
import { SEVERITY_RANK } from '../../models/SecurityAlert.js';
import { resolveNotificationTargets, webhookOrigin } from './config.js';
import { SECURITY_ALERT_TEMPLATE } from '../../templates/emails/securityAlert.js';

const DELIVERY_KIND = 'security_alert';

const DEFAULT_SINKS = Object.freeze({
  email: ({ alert, targets }) => deliver({
    tenantId: null,
    kind: DELIVERY_KIND,
    destination: { type: 'email', to: targets.emails },
    // Rendered by the outbox from the registered template (flat variables).
    payload: { template: SECURITY_ALERT_TEMPLATE, variables: buildEmailVariables(alert) },
    idempotencyKey: `security-alert:${alert._id}:email`,
  }),
  webhook: ({ alert, payload, targets }) => deliver({
    tenantId: null,
    kind: DELIVERY_KIND,
    destination: { type: 'webhook', url: targets.webhookUrl },
    payload,
    idempotencyKey: `security-alert:${alert._id}:webhook`,
  }),
});

let sinks = { ...DEFAULT_SINKS };
let targetResolver = resolveNotificationTargets;

/** Replace channel sinks (tests: capture sinks). Unlisted channels keep the default. */
export function setNotificationSinks(overrides = {}) {
  sinks = { ...DEFAULT_SINKS, ...overrides };
}

/** Replace the target resolver (tests). */
export function setTargetResolver(resolver) {
  targetResolver = typeof resolver === 'function' ? resolver : resolveNotificationTargets;
}

/** Back to the delivery-pipeline sinks and the settings-based targets. */
export function resetNotifier() {
  sinks = { ...DEFAULT_SINKS };
  targetResolver = resolveNotificationTargets;
}

/** Minimum severity rank that notifies (SECURITY_ALERT_NOTIFY_MIN_SEVERITY). */
export function notifyThresholdRank() {
  return SEVERITY_RANK[env.securityDetection?.notifyMinSeverity] ?? SEVERITY_RANK.high;
}

function consoleLink(alert) {
  const base = String(env.cors?.clientUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/admin/security-alerts?alert=${alert._id}` : null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : '-';
}

/** Plain-text email for an alert. */
export function buildMessage(alert) {
  const counts = Object.entries(alert.evidence?.counts ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const link = consoleLink(alert);
  const lines = [
    `Severity: ${alert.severity.toUpperCase()}`,
    `Rule: ${alert.ruleId} (v${alert.ruleVersion})`,
    `Subject: ${alert.subject?.type} ${alert.subject?.display ?? alert.subject?.id}`,
    alert.tenantId ? `Tenant: ${alert.tenantId}` : null,
    `First seen: ${iso(alert.firstSeenAt)}`,
    `Last seen: ${iso(alert.lastSeenAt)}`,
    '',
    alert.summary || alert.title,
    counts ? `Counts: ${counts}` : null,
    '',
    link ? `Review and acknowledge: ${link}` : 'Review and acknowledge it in the admin portal (Security alerts).',
  ].filter((line) => line !== null);
  return {
    subject: `[Security alert] ${alert.severity.toUpperCase()}: ${alert.title}`.slice(0, 250),
    text: lines.join('\n'),
  };
}

/**
 * Flat scalar variables for the `security.alert_raised` email template
 * (`templates/emails/securityAlert.js`); the same facts as `buildMessage`.
 */
export function buildEmailVariables(alert) {
  const counts = Object.entries(alert.evidence?.counts ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return {
    severity: String(alert.severity ?? '').toUpperCase(),
    title: String(alert.title ?? '').slice(0, 200),
    ruleId: String(alert.ruleId ?? ''),
    ruleVersion: String(alert.ruleVersion ?? ''),
    subject: `${alert.subject?.type ?? '-'} ${alert.subject?.display ?? alert.subject?.id ?? '-'}`,
    tenant: alert.tenantId ? String(alert.tenantId) : '-',
    firstSeenAt: iso(alert.firstSeenAt),
    lastSeenAt: iso(alert.lastSeenAt),
    summary: String(alert.summary || alert.title || ''),
    counts: counts || '-',
    reviewUrl: consoleLink(alert) ?? '',
  };
}

/** JSON body for the generic webhook. */
export function buildPayload(alert) {
  return {
    type: 'security_alert',
    alert: {
      id: String(alert._id),
      ruleId: alert.ruleId,
      ruleVersion: alert.ruleVersion,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      summary: alert.summary,
      subject: alert.subject,
      tenantId: alert.tenantId ?? null,
      firstSeenAt: alert.firstSeenAt,
      lastSeenAt: alert.lastSeenAt,
      occurrences: alert.occurrences,
      counts: alert.evidence?.counts ?? null,
    },
    url: consoleLink(alert),
  };
}

async function send(channel, context, at) {
  const target = channel === 'email' ? context.targets.emails.join(', ').slice(0, 300) : webhookOrigin(context.targets.webhookUrl);
  try {
    const result = await sinks[channel](context);
    return {
      at,
      channel,
      target,
      status: result?.status === 'sent' ? 'sent' : 'queued',
      code: null,
      deliveryId: result?.id ? String(result.id) : null,
    };
  } catch (err) {
    logger.warn({ err: { message: err?.message, code: err?.code }, channel, alertId: String(context.alert._id) }, '[security-detection] alert notification failed');
    return { at, channel, target, status: 'failed', code: String(err?.code ?? 'DELIVERY_FAILED').slice(0, 64), deliveryId: null };
  }
}

/**
 * Notify the on-call targets about an alert, at most once per alert.
 *
 * @param {Object} alert - plain alert document.
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<{ notified: boolean, skipped?: string, entries?: Array }>}
 */
export async function notifyAlert(alert, { now = clock.now() } = {}) {
  const claimed = await securityAlertRepository.claimNotification(alert._id, now);
  if (!claimed) return { notified: false, skipped: 'already_notified' };

  const targets = await targetResolver();
  const context = {
    alert: claimed,
    message: buildMessage(claimed),
    payload: buildPayload(claimed),
    targets: { emails: targets?.emails ?? [], webhookUrl: targets?.webhookUrl ?? null },
  };
  const entries = [];
  if (context.targets.emails.length > 0) entries.push(await send('email', context, now));
  if (context.targets.webhookUrl) entries.push(await send('webhook', context, now));
  if (entries.length === 0) {
    logger.warn({ alertId: String(claimed._id), ruleId: claimed.ruleId }, '[security-detection] no on-call target configured for a security alert');
    entries.push({ at: now, channel: 'none', target: null, status: 'skipped', code: 'NO_TARGETS', deliveryId: null });
  }
  await securityAlertRepository.recordNotifications(claimed._id, entries, now);

  for (const entry of entries.filter((e) => e.status === 'failed' || e.code === 'NO_TARGETS')) {
    await securityEvent('SECURITY_ALERT_NOTIFICATION_FAILED', {
      actor: { type: 'system', id: null, display: 'security-detection' },
      tenantId: claimed.tenantId ?? null,
      resource: { type: 'security_alert', id: String(claimed._id) },
      reason: entry.code,
      metadata: { alertId: String(claimed._id), ruleId: claimed.ruleId, channel: entry.channel, code: entry.code },
    });
  }
  return { notified: entries.some((e) => e.status === 'sent' || e.status === 'queued'), entries };
}

export default {
  notifyAlert,
  notifyThresholdRank,
  buildMessage,
  buildEmailVariables,
  buildPayload,
  setNotificationSinks,
  setTargetResolver,
  resetNotifier,
};
