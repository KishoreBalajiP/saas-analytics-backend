/**
 * Security Alert Service (roadmap 2.6 - platform security detection).
 *
 * PURPOSE
 *   The admin triage surface for alerts raised by the detector
 *   (`services/securityDetection/engine.js`): list and filter, read one
 *   alert with its evidence, acknowledge (takes ownership), mark as a false
 *   positive or resolve with a note, and describe the rule catalogue with
 *   its effective thresholds and watermarks.
 *
 * RULES
 *   - Lifecycle: open -> acknowledged -> resolved | false_positive, and
 *     open -> resolved | false_positive. Every transition is a conditional
 *     update on the current status (two admins cannot both win); an invalid
 *     one is a 409 SECURITY_ALERT_STATE_CONFLICT carrying the current status.
 *   - Closing (resolve / false positive) needs a note and releases the dedupe
 *     key, so a later detection opens a new alert (or is suppressed for a
 *     while after a false positive).
 *   - Every transition is recorded as a security event with the acting admin.
 *   - Tenant-scoped administrators only see alerts about their tenant;
 *     platform-level alerts (no tenant) and other tenants' alerts are 404 for
 *     them.
 */

import ApiError from '../utils/ApiError.js';
import clock from '../utils/clock.js';
import securityAlertRepository from '../repositories/securityAlert.repository.js';
import securityDetectionCursorRepository from '../repositories/securityDetectionCursor.repository.js';
import { securityEvent } from './securityEvent.service.js';
import { RULES } from './securityDetection/rules/index.js';
import { resolveRuleConfigs } from './securityDetection/config.js';
import { NOTE_MAX_LENGTH } from '../models/SecurityAlert.js';

export const STATE_CONFLICT = 'SECURITY_ALERT_STATE_CONFLICT';

/** A real tenant scope (null / '' / '*' mean platform-wide). */
function scopeOf(tenantScope) {
  if (tenantScope === undefined || tenantScope === null || tenantScope === '' || tenantScope === '*') return null;
  return String(tenantScope);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function actorDto(actor) {
  return actor ? { id: actor.id ?? null, display: actor.display ?? null } : null;
}

/** Public shape of an alert. `full` adds evidence refs, history and notifications. */
export function toDto(alert, { full = false } = {}) {
  if (!alert) return null;
  const dto = {
    id: String(alert._id),
    ruleId: alert.ruleId,
    ruleVersion: alert.ruleVersion,
    title: alert.title,
    summary: alert.summary ?? '',
    severity: alert.severity,
    status: alert.status,
    subject: {
      type: alert.subject?.type ?? null,
      id: alert.subject?.id ?? null,
      display: alert.subject?.display ?? null,
    },
    tenantId: alert.tenantId ?? null,
    firstSeenAt: iso(alert.firstSeenAt),
    lastSeenAt: iso(alert.lastSeenAt),
    windowStart: iso(alert.windowStart),
    windowEnd: iso(alert.windowEnd),
    occurrences: alert.occurrences ?? 1,
    counts: alert.evidence?.counts ?? null,
    owner: actorDto(alert.owner),
    acknowledgedAt: iso(alert.acknowledgedAt),
    acknowledgedBy: actorDto(alert.acknowledgedBy),
    closedAt: iso(alert.closedAt),
    closedBy: actorDto(alert.closedBy),
    resolutionNote: alert.resolutionNote ?? null,
    notifiedAt: iso(alert.notifiedAt),
    createdAt: iso(alert.createdAt),
    updatedAt: iso(alert.updatedAt),
  };
  if (full) {
    dto.evidence = {
      counts: alert.evidence?.counts ?? null,
      details: alert.evidence?.details ?? null,
      refs: (alert.evidence?.refs ?? []).map((ref) => ({
        source: ref.source, id: ref.id ?? null, at: iso(ref.at), label: ref.label ?? '',
      })),
    };
    dto.history = (alert.history ?? []).map((entry) => ({
      at: iso(entry.at),
      action: entry.action,
      by: actorDto(entry.by),
      from: entry.from ?? null,
      to: entry.to ?? null,
      note: entry.note ?? null,
    }));
    dto.notifications = (alert.notifications ?? []).map((entry) => ({
      at: iso(entry.at),
      channel: entry.channel,
      target: entry.target ?? null,
      status: entry.status,
      code: entry.code ?? null,
    }));
  }
  return dto;
}

/** Load an alert the caller may see, or 404. */
async function loadVisible(id, tenantScope) {
  const alert = await securityAlertRepository.findById(id);
  const scope = scopeOf(tenantScope);
  if (!alert || (scope && alert.tenantId !== scope)) throw ApiError.notFound('Security alert not found');
  return alert;
}

/**
 * Paginated triage list (newest activity first) with per-status counts for
 * the same filters.
 */
export async function list({ filters = {}, page = 1, limit = 20, tenantScope = null } = {}) {
  const scope = scopeOf(tenantScope);
  const filter = securityAlertRepository.buildFilter({ ...filters, tenantId: scope ?? filters.tenantId });
  const [result, statusCounts] = await Promise.all([
    securityAlertRepository.list({ filter, page, limit }),
    securityAlertRepository.countByStatus(filter),
  ]);
  return {
    docs: result.docs.map((alert) => toDto(alert)),
    meta: { page: result.page, limit: result.limit, total: result.total, pages: result.pages, statusCounts },
  };
}

/** One alert with its evidence, history and notifications. */
export async function getById({ id, tenantScope = null } = {}) {
  return toDto(await loadVisible(id, tenantScope), { full: true });
}

const TRANSITIONS = Object.freeze({
  acknowledge: { from: ['open'], to: 'acknowledged', event: 'SECURITY_ALERT_ACKNOWLEDGED', noteRequired: false },
  false_positive: { from: ['open', 'acknowledged'], to: 'false_positive', event: 'SECURITY_ALERT_FALSE_POSITIVE', noteRequired: true },
  resolve: { from: ['open', 'acknowledged'], to: 'resolved', event: 'SECURITY_ALERT_RESOLVED', noteRequired: true },
});

function conflict(alert, action) {
  return new ApiError(409, `This alert is ${alert.status.replace('_', ' ')}; it cannot be ${action === 'acknowledge' ? 'acknowledged' : 'closed'} again`, {
    code: STATE_CONFLICT,
    errors: [{ field: 'status', message: `current status is ${alert.status}` }],
  });
}

/**
 * Apply a triage transition.
 *
 * @param {Object} params
 * @param {'acknowledge'|'false_positive'|'resolve'} params.action
 * @param {string} params.id
 * @param {{ id: string, email?: string|null, tenantId?: string|null }} params.admin
 * @param {string} [params.note]
 * @param {Object} [params.request] - `{ ip, userAgent, requestId }` for the audit trail.
 * @returns {Promise<Object>} the updated alert (full DTO).
 */
export async function transition({ action, id, admin, note, request = {} } = {}) {
  const spec = TRANSITIONS[action];
  if (!spec) throw ApiError.badRequest('Unknown alert action');
  if (!admin?.id) throw ApiError.forbidden('Authenticated administrator is required');
  const text = typeof note === 'string' ? note.trim() : '';
  if (spec.noteRequired && text.length === 0) {
    throw ApiError.validation('A note is required', [{ field: 'note', message: 'Explain why the alert is closed' }]);
  }
  if (text.length > NOTE_MAX_LENGTH) {
    throw ApiError.validation('Note is too long', [{ field: 'note', message: `at most ${NOTE_MAX_LENGTH} characters` }]);
  }

  const alert = await loadVisible(id, admin.tenantId);
  if (!spec.from.includes(alert.status)) throw conflict(alert, action);

  const now = clock.now();
  const by = { id: String(admin.id), display: admin.email ?? null };
  const set = { status: spec.to };
  if (action === 'acknowledge') {
    set.acknowledgedAt = now;
    set.acknowledgedBy = by;
    set.owner = by;
  } else {
    set.closedAt = now;
    set.closedBy = by;
    set.resolutionNote = text;
    if (!alert.owner) set.owner = by;
  }
  const updated = await securityAlertRepository.transition(alert._id, {
    fromStatuses: spec.from,
    set,
    unsetActive: action !== 'acknowledge',
    history: { at: now, action: spec.to, by, from: alert.status, to: spec.to, note: text || null },
  });
  if (!updated) {
    // Someone else changed it between our read and the update.
    const current = (await securityAlertRepository.findById(alert._id)) ?? alert;
    throw conflict(current, action);
  }

  await securityEvent(spec.event, {
    actor: { type: 'admin', id: String(admin.id), display: admin.email ?? null },
    tenantId: updated.tenantId ?? null,
    resource: { type: 'security_alert', id: String(updated._id) },
    reason: text || undefined,
    metadata: {
      alertId: String(updated._id),
      ruleId: updated.ruleId,
      severity: updated.severity,
      from: alert.status,
      to: spec.to,
    },
    ip: request.ip,
    userAgent: request.userAgent,
    requestId: request.requestId,
  });
  return toDto(updated, { full: true });
}

/**
 * The rule catalogue: definition, effective thresholds (with ignored
 * overrides) and the detector's watermark per rule.
 */
export async function listRules() {
  const [configs, cursors] = await Promise.all([
    resolveRuleConfigs(RULES),
    securityDetectionCursorRepository.listAll(),
  ]);
  const byRule = new Map(cursors.map((cursor) => [cursor._id, cursor]));
  return RULES.map((rule) => {
    const { config, ignored } = configs.get(rule.id);
    const cursor = byRule.get(rule.id);
    return {
      id: rule.id,
      version: rule.version,
      title: rule.title,
      description: rule.description,
      source: rule.source,
      severity: rule.severity,
      enabled: config.enabled !== false,
      config,
      defaults: rule.defaults,
      ignoredOverrides: ignored,
      watermark: iso(cursor?.watermark),
      lastRunAt: iso(cursor?.lastRunAt),
      lastDetections: cursor?.lastDetections ?? 0,
      lastError: cursor?.lastError ?? null,
    };
  });
}

export default { list, getById, transition, listRules, toDto, STATE_CONFLICT };
