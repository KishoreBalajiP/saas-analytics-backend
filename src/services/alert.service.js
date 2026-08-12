/**
 * Alert Service (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Business logic for threshold-based alert rules over an analytics query.
 *   On evaluation the chosen metric is aggregated and compared against the
 *   threshold; when the condition holds (and the cooldown has elapsed) an
 *   AlertEvent is recorded and notifications are dispatched.
 *
 * EVALUATION
 *   - `evaluate` runs a single rule (manual request or alert-triggered job).
 *   - `evaluateDue` scans enabled rules whose `nextEvaluationAt` is due and
 *     is driven by a per-minute scheduler job.
 *   - `nextEvaluationAt` is re-projected from `schedule.cron` after each run.
 *
 * RESPONSIBILITY
 *   - listRules, createRule, getById, updateRule, removeRule, listEvents
 *   - evaluate, evaluateDue
 */

import ApiError from '../utils/ApiError.js';
import alertRepository from '../repositories/alert.repository.js';
import notificationRepository from '../repositories/notification.repository.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as engine from './analytics.engine.js';
import * as emailService from './email.service.js';
import * as auditLogService from './auditLog.service.js';
import { DATE_RANGE_PRESETS } from '../models/Dashboard.js';
import { QUERY_FIELDS } from '../models/Widget.js';
import { ALERT_CONDITIONS, ALERT_SOURCES, ALERT_CHANNELS } from '../models/AlertRule.js';
import { nextCronDate } from '../utils/cron.js';

const DEFAULT_CRON = '*/5 * * * *';

/* ------------------------------ helpers ---------------------------------- */

function resolveDateRange(dateRange, now = new Date()) {
  if (!dateRange || typeof dateRange !== 'object') return null;
  const { preset, from, to } = dateRange;
  if (!preset) return { from: from ?? null, to: to ?? null };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  switch (preset) {
    case 'today': return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'yesterday': {
      const day = new Date(now); day.setDate(day.getDate() - 1);
      return { from: startOfDay(day).toISOString(), to: endOfDay(day).toISOString() };
    }
    case 'last_7_days': {
      const from = new Date(now); from.setDate(from.getDate() - 6);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'last_30_days': {
      const from = new Date(now); from.setDate(from.getDate() - 29);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'custom': return { from: from ?? null, to: to ?? null };
    default: return null;
  }
}

function sanitizeAlertQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('alert query must be an object');
  }
  const out = {};
  for (const key of QUERY_FIELDS) {
    if (query[key] !== undefined) out[key] = query[key];
  }
  if (query.datasetId !== undefined) out.datasetId = String(query.datasetId);
  if (out.filtersOp !== undefined && !['and', 'or'].includes(out.filtersOp)) {
    throw ApiError.badRequest('query.filtersOp must be "and" or "or"');
  }
  if (out.dateRange !== undefined) out.dateRange = resolveDateRange(out.dateRange);
  return out;
}

async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('alert dataset must be a connector owned by the tenant');
  return connector;
}

/** Resolve effective engine params + datasetId for an alert rule. */
async function resolveAlertQuery({ tenantId, alert }) {
  let datasetId;
  let params;
  if (alert.source === 'widget') {
    const dashboard = await dashboardRepository.findById(alert.dashboardId, { tenantId });
    if (!dashboard) throw ApiError.notFound('Dashboard not found');
    const widget = await widgetRepository.findById(alert.widgetId, { tenantId, dashboardId: alert.dashboardId });
    if (!widget) throw ApiError.notFound('Widget not found');
    await assertDatasetOwned(tenantId, widget.datasetId);
    datasetId = String(widget.datasetId);
    const widgetQuery = widget.query && typeof widget.query === 'object' ? widget.query : {};
    const dashboardFilters = dashboard.filters && typeof dashboard.filters === 'object' ? dashboard.filters : {};
    params = {
      filters: widgetQuery.filters ?? dashboardFilters.filters ?? [],
      filtersOp: widgetQuery.filtersOp ?? dashboardFilters.filtersOp ?? 'and',
      dateRange: resolveDateRange(widgetQuery.dateRange ?? dashboardFilters.dateRange ?? null),
      metrics: widgetQuery.metrics ?? [],
      groupBy: widgetQuery.groupBy ?? [],
      orderBy: widgetQuery.orderBy ?? [],
      pagination: widgetQuery.pagination ?? {},
    };
  } else {
    const q = (alert.query && typeof alert.query === 'object') ? alert.query : {};
    if (!q.datasetId) throw ApiError.badRequest('alert query requires a datasetId');
    await assertDatasetOwned(tenantId, q.datasetId);
    datasetId = String(q.datasetId);
    params = {
      filters: q.filters ?? [],
      filtersOp: q.filtersOp ?? 'and',
      dateRange: resolveDateRange(q.dateRange ?? null),
      metrics: q.metrics ?? [],
      groupBy: q.groupBy ?? [],
      orderBy: q.orderBy ?? [],
      pagination: q.pagination ?? {},
    };
  }
  return { datasetId, params };
}

/** Aggregate the chosen metric across the engine result. */
function extractMetric(result, metric) {
  if (result.groupMode) {
    const columns = result.columns || [];
    const col = columns.includes(metric) ? metric : columns.includes('count') ? 'count' : null;
    if (col) {
      return (result.rows || []).reduce((sum, r) => sum + (Number(r[col]) || 0), 0);
    }
    return result.total;
  }
  // Raw mode: the only meaningful aggregate is the row count.
  return result.total;
}

/** Evaluate a threshold condition against the observed value. */
function compare(condition, value, threshold, thresholdHigh) {
  const v = Number(value);
  const t = Number(threshold);
  switch (condition) {
    case 'gt': return v > t;
    case 'gte': return v >= t;
    case 'lt': return v < t;
    case 'lte': return v <= t;
    case 'eq': return v === t;
    case 'neq': return v !== t;
    case 'between': return v >= t && v <= Number(thresholdHigh);
    default: return false;
  }
}

async function dispatchNotifications({ tenantId, alert, value, event }) {
  const channels = alert.notification?.channels || ['in_app'];
  const recipients = alert.notification?.recipients || [];
  const userIds = new Set();
  recipients.filter((r) => r.type === 'user').forEach((r) => userIds.add(r.value));
  if (alert.createdBy) userIds.add(alert.createdBy);

  for (const ch of channels) {
    if (ch === 'in_app') {
      for (const uid of userIds) {
        await notificationRepository.create({
          tenantId,
          recipientId: uid,
          channel: 'in_app',
          type: 'alert',
          title: `Alert: ${alert.name}`,
          body: event.message,
          data: { alertId: String(alert._id), eventId: String(event._id), value },
          relatedResource: { type: 'alert', id: String(alert._id) },
        });
      }
    } else if (ch === 'email') {
      const emails = recipients.filter((r) => r.type === 'email').map((r) => r.value);
      for (const em of emails) {
        try {
          await emailService.send({
            to: em,
            subject: `Alert triggered: ${alert.name}`,
            text: event.message,
          });
        } catch {
          /* best-effort delivery */
        }
      }
    }
  }
}

async function audit(entry) {
  try {
    await auditLogService.emit(entry);
  } catch {
    /* best-effort */
  }
}

/* ------------------------------- service --------------------------------- */

/** Paginated, tenant-scoped alert rule list. */
export async function listRules({ tenantId, page = 1, limit = 20, enabled } = {}) {
  const filter = {};
  if (typeof enabled === 'boolean') filter.enabled = enabled;
  return alertRepository.listRules({ tenantId, filter, page, limit });
}

/** Create an alert rule. */
export async function createRule({
  tenantId,
  actorId = null,
  name,
  description = '',
  source = 'widget',
  dashboardId,
  widgetId,
  query,
  metric = 'count',
  condition,
  threshold,
  thresholdHigh = null,
  schedule = null,
  cooldownMinutes = 60,
  notification = null,
  enabled = true,
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw ApiError.badRequest('alert name is required');
  if (!ALERT_CONDITIONS.includes(condition)) throw ApiError.badRequest('invalid alert condition');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw ApiError.badRequest('alert threshold is required and must be a number');
  }
  if (!ALERT_SOURCES.includes(source)) throw ApiError.badRequest('invalid alert source');

  let resolvedQuery = null;
  if (source === 'widget') {
    if (!dashboardId || !widgetId) throw ApiError.badRequest('widget source requires dashboardId and widgetId');
  } else {
    if (!query || !query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    resolvedQuery = sanitizeAlertQuery(query);
  }

  const notificationObj = {
    channels: notification?.channels && notification.channels.every((c) => ALERT_CHANNELS.includes(c))
      ? notification.channels
      : ['in_app'],
    recipients: notification?.recipients || [],
    template: notification?.template || null,
  };

  const doc = await alertRepository.createRule({
    tenantId,
    name: name.trim(),
    description: description ?? '',
    enabled: Boolean(enabled),
    source,
    dashboardId: source === 'widget' ? String(dashboardId) : null,
    widgetId: source === 'widget' ? String(widgetId) : null,
    query: source === 'query' ? resolvedQuery : null,
    metric,
    condition,
    threshold,
    thresholdHigh: condition === 'between' ? Number(thresholdHigh) : null,
    schedule: schedule ? { cron: schedule.cron || DEFAULT_CRON, timezone: schedule.timezone || 'UTC' } : { cron: DEFAULT_CRON, timezone: 'UTC' },
    cooldownMinutes: Math.max(0, Number(cooldownMinutes) || 0),
    notification: notificationObj,
    nextEvaluationAt: new Date(),
    createdBy: actorId,
  });

  await audit({
    tenantId, actorId, action: 'alert.created', module: 'alerts',
    resource: { type: 'alert', id: String(doc._id) }, after: { name: doc.name, condition: doc.condition },
  });
  return doc;
}

/** Fetch an alert rule by id. */
export async function getById({ tenantId, alertId } = {}) {
  const rule = await alertRepository.findRuleById(alertId, { tenantId });
  if (!rule) throw ApiError.notFound('Alert not found');
  return rule;
}

/** Update an alert rule (whitelisted fields). */
export async function updateRule({ tenantId, alertId, actorId = null, patch = {} } = {}) {
  const existing = await alertRepository.findRuleById(alertId, { tenantId });
  if (!existing) throw ApiError.notFound('Alert not found');

  const updates = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw ApiError.badRequest('alert name must be a non-empty string');
    updates.name = patch.name.trim();
  }
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.enabled !== undefined) updates.enabled = Boolean(patch.enabled);
  if (patch.metric !== undefined) updates.metric = patch.metric;
  if (patch.condition !== undefined) {
    if (!ALERT_CONDITIONS.includes(patch.condition)) throw ApiError.badRequest('invalid alert condition');
    updates.condition = patch.condition;
  }
  if (patch.threshold !== undefined) {
    if (typeof patch.threshold !== 'number' || !Number.isFinite(patch.threshold)) {
      throw ApiError.badRequest('alert threshold must be a number');
    }
    updates.threshold = patch.threshold;
  }
  if (patch.thresholdHigh !== undefined) {
    updates.thresholdHigh = patch.condition === 'between' || existing.condition === 'between' ? Number(patch.thresholdHigh) : null;
  }
  if (patch.cooldownMinutes !== undefined) {
    updates.cooldownMinutes = Math.max(0, Number(patch.cooldownMinutes) || 0);
  }
  if (patch.schedule !== undefined) {
    updates.schedule = {
      cron: patch.schedule.cron || existing.schedule?.cron || DEFAULT_CRON,
      timezone: patch.schedule.timezone || existing.schedule?.timezone || 'UTC',
    };
  }
  if (patch.source !== undefined || patch.dashboardId || patch.widgetId) {
    const source = patch.source || existing.source;
    if (!ALERT_SOURCES.includes(source)) throw ApiError.badRequest('invalid alert source');
    updates.source = source;
    updates.dashboardId = String(patch.dashboardId ?? existing.dashboardId);
    updates.widgetId = String(patch.widgetId ?? existing.widgetId);
    if (source === 'widget' && (!updates.dashboardId || !updates.widgetId)) {
      throw ApiError.badRequest('widget source requires dashboardId and widgetId');
    }
  }
  if (patch.query !== undefined) {
    if (!patch.query || !patch.query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    updates.query = sanitizeAlertQuery(patch.query);
  }
  if (patch.notification !== undefined) {
    updates.notification = {
      channels: patch.notification.channels && patch.notification.channels.every((c) => ALERT_CHANNELS.includes(c))
        ? patch.notification.channels
        : ['in_app'],
      recipients: patch.notification.recipients || [],
      template: patch.notification.template || null,
    };
  }

  if (Object.keys(updates).length === 0) return existing;
  updates.updatedBy = actorId;
  const updated = await alertRepository.updateRule(alertId, updates);
  if (!updated) throw ApiError.notFound('Alert not found');

  await audit({
    tenantId, actorId, action: 'alert.updated', module: 'alerts',
    resource: { type: 'alert', id: alertId }, after: updates,
  });
  return updated;
}

/** Soft-delete an alert rule. */
export async function removeRule({ tenantId, alertId, actorId = null } = {}) {
  const existing = await alertRepository.findRuleById(alertId, { tenantId });
  if (!existing) throw ApiError.notFound('Alert not found');
  await alertRepository.removeRule(alertId, actorId);
  await audit({
    tenantId, actorId, action: 'alert.deleted', module: 'alerts',
    resource: { type: 'alert', id: alertId },
  });
  return true;
}

/** List evaluation events for a tenant (optionally for one alert). */
export async function listEvents({ tenantId, alertId, page = 1, limit = 20 } = {}) {
  return alertRepository.listEvents({ tenantId, alertId, page, limit });
}

/**
 * Evaluate a single alert rule: aggregate the metric, compare to threshold,
 * respect the cooldown, record an event, and dispatch notifications.
 */
export async function evaluate({ tenantId, alertId, triggeredBy = 'manual', runBy = null } = {}) {
  const alert = await alertRepository.findRuleById(alertId, { tenantId });
  if (!alert) throw ApiError.notFound('Alert not found');
  if (alert.enabled === false) {
    return { triggered: false, suppressed: false, value: null, conditionMet: false, event: null, disabled: true };
  }

  const { datasetId, params } = await resolveAlertQuery({ tenantId, alert });
  const result = await engine.queryRows({ tenantId, connectorIds: [datasetId], ...params });
  const value = extractMetric(result, alert.metric);
  const conditionMet = compare(alert.condition, value, alert.threshold, alert.thresholdHigh);
  const now = new Date();
  let event = null;
  let triggered = false;
  let suppressed = false;

  if (conditionMet) {
    const inCooldown = alert.lastTriggeredAt
      && (now - new Date(alert.lastTriggeredAt)) < alert.cooldownMinutes * 60000;
    if (inCooldown) {
      suppressed = true;
    } else {
      triggered = true;
      event = await alertRepository.createEvent({
        tenantId,
        alertId: alert._id,
        name: alert.name,
        value,
        condition: alert.condition,
        threshold: alert.threshold,
        thresholdHigh: alert.thresholdHigh,
        status: 'triggered',
        message: `Alert "${alert.name}" triggered: ${alert.metric} = ${value} ${alert.condition} ${alert.threshold}`,
        runBy,
      });
      await dispatchNotifications({ tenantId, alert, value, event });
      await alertRepository.markEvaluated(alert._id, {
        lastEvaluatedAt: now,
        lastTriggeredAt: now,
        nextEvaluationAt: nextCronDate(alert.schedule?.cron || DEFAULT_CRON, now),
      });
    }
  } else {
    await alertRepository.markEvaluated(alert._id, {
      lastEvaluatedAt: now,
      nextEvaluationAt: nextCronDate(alert.schedule?.cron || DEFAULT_CRON, now),
    });
  }

  return { triggered, suppressed, value, conditionMet, event };
}

/** Scheduler scan: evaluate every enabled alert whose next run is due. */
export async function evaluateDue({ now = new Date(), limit = 100 } = {}) {
  const due = await alertRepository.findDueRules({ now, limit });
  let evaluated = 0;
  const triggered = [];
  for (const rule of due) {
    try {
      const result = await evaluate({ tenantId: rule.tenantId, alertId: String(rule._id), triggeredBy: 'schedule' });
      evaluated += 1;
      if (result.triggered) triggered.push(String(rule._id));
    } catch {
      /* continue with the next due alert */
    }
  }
  return { evaluated, triggered: triggered.length };
}

export default {
  listRules,
  createRule,
  getById,
  updateRule,
  removeRule,
  listEvents,
  evaluate,
  evaluateDue,
  _meta: { module: 'alerts' },
};
