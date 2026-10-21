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
 *   - `nextEvaluationAt` is re-projected from `schedule.cron` after EVERY
 *     evaluation (triggered, suppressed, not met, no data, failed) and the
 *     outcome is stored on `lastEvaluation`.
 *
 * METRIC CONTRACT (`measure`)
 *   - `metric` must name an output column of the rule's query: one of its
 *     metric aliases (`<op>_<field>` unless aliased, see the engine), or
 *     `count` when the query defines no metrics. Anything else is a 400
 *     ALERT_METRIC_INVALID at save time (field `metric`) and a failed
 *     evaluation (same code) when the query changed after saving.
 *   - `groupEvaluation: 'total'` (default) computes the metric ONCE over the
 *     whole filtered dataset: groupBy, orderBy and pagination are dropped and
 *     the engine aggregates server-side (sum/avg/min/max/count are exact,
 *     an average is never an average of group averages).
 *   - `'any'` / `'all'` read EVERY group (all pages, at most
 *     ALERT_MAX_GROUPS, else 422 ALERT_TOO_MANY_GROUPS) and the condition
 *     holds when some / every group with a value meets it. `value` is the
 *     group value that decided the outcome (the most extreme matching group
 *     for `any`, the weakest group for `all`).
 *   - No data: no rows (or no numeric values) for avg/min/max, or no groups,
 *     gives `value: null` and outcome `no_data`; the condition is not met.
 *     `count` and `sum` over no rows are 0 and are compared normally.
 *
 * COOLDOWN
 *   Triggering takes an atomic claim on the rule (`claimTrigger`): only
 *   when it never triggered or `cooldownMinutes` have passed since the last
 *   trigger. Within the cooldown (or when a concurrent evaluation won the
 *   claim) the evaluation is `suppressed`: it is recorded (a `suppressed`
 *   event, `lastEvaluation`), the next evaluation is still projected, and
 *   no notification is sent.
 *
 * QUERY CONTRACT
 *   Query-source alerts store a query validated by the analytics engine's
 *   strict contract (`QUERY_FIELDS` + `datasetId`). Relative date presets
 *   are stored as presets and resolved at every evaluation in the workspace
 *   time zone. Widget-source alerts read the widget's effective query the
 *   same way widget execution does (`dashboard.service.mergeWidgetQuery`).
 *
 * SCHEDULES
 *   `schedule.timezone` is an optional IANA override; when empty the cron
 *   runs in the workspace time zone (`localization.timezone`).
 *
 * RESPONSIBILITY
 *   - listRules, createRule, getById, updateRule, removeRule, listEvents
 *   - evaluate, evaluateDue, reprojectSchedules
 */

// rls: background runs query as their owner.
import dataAccess from './dataAccess.service.js';
import ApiError from '../utils/ApiError.js';
import entitlementService from './entitlement.service.js';
import usageService from './usage.service.js';
import alertRepository from '../repositories/alert.repository.js';
import notificationRepository from '../repositories/notification.repository.js';
// delivery: roadmap 3.4 - alert email/destination notifications go through the pipeline.
import * as deliveryService from './delivery/index.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as engine from './analytics.engine.js';
// ai-catalogue: P7 attribution of alert evaluations.
import { recordRun } from './queryAttribution.service.js';
import * as dashboardService from './dashboard.service.js';
import * as auditLogService from './auditLog.service.js';
// onboarding: per-user notification preferences.
import * as notificationService from './notification.service.js';
import { getTimezone as getWorkspaceTimezone } from './tenantSettings.service.js';
import { QUERY_FIELDS } from '../models/Widget.js';
import { ALERT_CONDITIONS, ALERT_SOURCES, ALERT_CHANNELS, ALERT_GROUP_EVALUATIONS } from '../models/AlertRule.js';
import { nextCronDate, assertValidCron } from '../utils/cron.js';
import { isValidTimeZone, normalizeTimeZone } from '../utils/timezone.js';
import clock from '../utils/clock.js';
import { newClaimOwner, claimLeaseMs, safeNextRun, createTenantStatusCache } from '../jobs/claims.js';

const DEFAULT_CRON = '*/5 * * * *';
/** Pages of groups (at the engine's page-size maximum) a per-group alert reads. */
const ALERT_MAX_GROUP_PAGES = 25;
/** Most groups a per-group (`any` / `all`) alert evaluates. */
export const ALERT_MAX_GROUPS = ALERT_MAX_GROUP_PAGES * 200;
/** Groups listed on a per-group event. */
const ALERT_EVENT_GROUP_SAMPLE = 5;

export const ALERT_ERROR_CODES = Object.freeze({
  METRIC_INVALID: 'ALERT_METRIC_INVALID',
  TOO_MANY_GROUPS: 'ALERT_TOO_MANY_GROUPS',
});

/* ------------------------------ helpers ---------------------------------- */

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** `datasetId` of a query-source alert: a dataset id string. */
function validateDatasetId(value, at, fail) {
  const id = String(value);
  if (!OBJECT_ID_RE.test(id)) fail(at, 'must be a dataset id');
  return id;
}

/** Validate an alert query against the engine contract; presets are kept. */
function sanitizeAlertQuery(query) {
  return engine.validateQuery(query, {
    keys: QUERY_FIELDS,
    prefix: 'query.',
    extra: { datasetId: validateDatasetId },
  });
}

/** A schedule's own time zone, or null to follow the workspace time zone. */
function scheduleTimezone(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidTimeZone(value)) {
    throw ApiError.badRequest('Invalid schedule time zone', [
      { field: 'schedule.timezone', message: 'must be an IANA time zone name, or empty to use the workspace time zone' },
    ]);
  }
  return normalizeTimeZone(value);
}

/** Next evaluation of a rule's cron in its effective time zone. */
async function projectNextEvaluation(tenantId, schedule, from = clock.now(), resolveWorkspaceZone = getWorkspaceTimezone) {
  const tz = schedule?.timezone ? normalizeTimeZone(schedule.timezone) : await resolveWorkspaceZone(tenantId);
  try {
    return nextCronDate(schedule?.cron || DEFAULT_CRON, from, tz);
  } catch {
    // A stored cron that cannot be parsed falls back to the default so the
    // rule is never left due forever (which re-fired it every tick).
    return nextCronDate(DEFAULT_CRON, from, tz);
  }
}

async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('alert dataset must be a connector owned by the tenant');
  return connector;
}

/** Resolve effective (unresolved) engine params + datasetId for an alert rule. */
async function resolveAlertQuery({ tenantId, alert }) {
  if (alert.source === 'widget') {
    const dashboard = await dashboardRepository.findById(alert.dashboardId, { tenantId });
    if (!dashboard) throw ApiError.notFound('Dashboard not found');
    const widget = await widgetRepository.findById(alert.widgetId, { tenantId, dashboardId: alert.dashboardId });
    if (!widget) throw ApiError.notFound('Widget not found');
    await assertDatasetOwned(tenantId, widget.datasetId);
    return { datasetId: String(widget.datasetId), params: dashboardService.mergeWidgetQuery({ widget, dashboard }) };
  }
  const q = (alert.query && typeof alert.query === 'object') ? alert.query : {};
  if (!q.datasetId) throw ApiError.badRequest('alert query requires a datasetId');
  await assertDatasetOwned(tenantId, q.datasetId);
  const { datasetId, ...params } = q;
  // The stored query is held to the contract it was saved under: a key
  // outside it (e.g. an engine option such as `tenantId`) is rejected.
  engine.validateQuery(params, { keys: QUERY_FIELDS });
  return { datasetId: String(datasetId), params };
}

/* ---------------------------- metric contract ---------------------------- */

/** Output columns of an (unresolved) alert query a metric may name. */
export function queryOutputs(params) {
  const metrics = Array.isArray(params?.metrics) ? params.metrics : [];
  return metrics.length ? metrics.map((m) => engine.metricAlias(m)) : ['count'];
}

/** The metric a rule uses when none is given: the query's first output. */
function defaultMetric(params) {
  return queryOutputs(params)[0];
}

function metricError(metric, outputs, { atSave }) {
  const list = outputs.join(', ');
  return new ApiError(400, atSave
    ? `Alert metric "${metric}" is not an output of the alert's query`
    : `Alert metric "${metric}" is no longer an output of the alert's query (outputs: ${list}); edit the alert`, {
    code: ALERT_ERROR_CODES.METRIC_INVALID,
    errors: [{ field: 'metric', message: `must be one of the query's outputs: ${list}` }],
  });
}

/** Throw 400 ALERT_METRIC_INVALID unless `metric` is an output of `params`. */
export function assertMetricInQuery(metric, params, { atSave = true } = {}) {
  const outputs = queryOutputs(params);
  if (typeof metric !== 'string' || !outputs.includes(metric)) throw metricError(metric, outputs, { atSave });
  return metric;
}

function validateGroupEvaluation(value) {
  if (!ALERT_GROUP_EVALUATIONS.includes(value)) {
    throw ApiError.badRequest('Invalid group evaluation', [
      { field: 'groupEvaluation', message: `must be one of ${ALERT_GROUP_EVALUATIONS.join(', ')}` },
    ]);
  }
  return value;
}

/** `between` needs a high threshold at or above the low one. */
function validateBetween(condition, threshold, thresholdHigh) {
  if (condition !== 'between') return null;
  const high = typeof thresholdHigh === 'number' ? thresholdHigh : Number.NaN;
  if (!Number.isFinite(high) || high < threshold) {
    throw ApiError.badRequest('Invalid alert thresholds', [
      { field: 'thresholdHigh', message: 'is required for between and must be at least threshold' },
    ]);
  }
  return high;
}

/** Evaluate a threshold condition against the observed value (finite numbers only). */
export function compare(condition, value, threshold, thresholdHigh) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const t = Number(threshold);
  switch (condition) {
    case 'gt': return value > t;
    case 'gte': return value >= t;
    case 'lt': return value < t;
    case 'lte': return value <= t;
    case 'eq': return value === t;
    case 'neq': return value !== t;
    case 'between': return value >= t && value <= Number(thresholdHigh);
    default: return false;
  }
}

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const LOW_WINS = new Set(['lt', 'lte']);
const HIGH_WINS = new Set(['gt', 'gte']);

/**
 * Reduce per-group values to the outcome of an `any` / `all` rule.
 * `groups` is [{ group, value }] with numeric values only.
 */
export function judgeGroups(groups, { mode, condition, threshold, thresholdHigh }) {
  if (!groups.length) return { conditionMet: false, value: null, matched: [] };
  const matched = groups.filter((g) => compare(condition, g.value, threshold, thresholdHigh));
  const max = (list) => list.reduce((a, b) => (b.value > a.value ? b : a));
  const min = (list) => list.reduce((a, b) => (b.value < a.value ? b : a));
  let decisive;
  let conditionMet;
  if (mode === 'any') {
    conditionMet = matched.length > 0;
    const pool = conditionMet ? matched : groups;
    decisive = HIGH_WINS.has(condition) ? max(pool) : LOW_WINS.has(condition) ? min(pool) : pool[0];
  } else {
    conditionMet = matched.length === groups.length;
    const failing = groups.find((g) => !compare(condition, g.value, threshold, thresholdHigh));
    decisive = HIGH_WINS.has(condition) ? min(groups) : LOW_WINS.has(condition) ? max(groups) : failing ?? groups[0];
  }
  return { conditionMet, value: decisive.value, matched };
}

/** Engine params without the keys `total` evaluation must not carry. */
function withoutPaging(params) {
  const { pagination: _p, orderBy: _o, ...rest } = params;
  return rest;
}

/**
 * Measure a rule's metric (see METRIC CONTRACT in the header).
 *
 * @returns {Promise<{ value: number|null, noData: boolean, conditionMet: boolean,
 *   mode: string, groupsEvaluated: number|null, groupsMatched: number|null, sample: object[]|null }>}
 */
export async function measure({ tenantId, datasetId, params, alert, now }) {
  const metric = assertMetricInQuery(alert.metric, params, { atSave: false });
  const metrics = Array.isArray(params.metrics) ? params.metrics : [];
  const metricDef = metrics.find((m) => engine.metricAlias(m) === metric) ?? { op: 'count' };
  const groupBy = Array.isArray(params.groupBy) ? params.groupBy : [];
  const mode = groupBy.length && alert.groupEvaluation && alert.groupEvaluation !== 'total' ? alert.groupEvaluation : 'total';
  // Execution keys go last so nothing in the stored query can replace them.
  // rls: alerts measure with their creator's data access.
  const run = (query) => dataAccess.runAsDataActor(
    dataAccess.userDataActor(alert.createdBy ?? null, tenantId),
    () => engine.queryRows({ ...query, tenantId, connectorIds: [datasetId], now }),
  );

  if (mode === 'total') {
    const { groupBy: _g, ...rest } = withoutPaging(params);
    // Only the asked-for metric, over the whole filtered dataset (one row).
    const result = await run({ ...rest, metrics: [metricDef] });
    const row = result.rows[0];
    let value = numeric(row?.[metric]);
    if (!row && (metricDef.op === 'count' || metricDef.op === 'sum')) value = 0;
    const conditionMet = compare(alert.condition, value, alert.threshold, alert.thresholdHigh);
    return { value, noData: value === null, conditionMet, mode, groupsEvaluated: null, groupsMatched: null, sample: null };
  }

  // Per group: every group, at the engine's page-size maximum.
  const base = { ...withoutPaging(params), metrics: metrics.length ? [metricDef] : [] };
  const rows = [];
  for (let page = 1; ; page += 1) {
    const result = await run({ ...base, pagination: { page, limit: engine.LIMITS.maxLimit } });
    if (result.total > ALERT_MAX_GROUPS) {
      throw new ApiError(422, `The alert query has ${result.total} groups; per-group evaluation reads at most ${ALERT_MAX_GROUPS}. Narrow the query or evaluate the total.`, {
        code: ALERT_ERROR_CODES.TOO_MANY_GROUPS,
      });
    }
    rows.push(...result.rows);
    if (page >= result.pages) break;
  }
  const fields = groupBy.map((g) => (typeof g === 'string' ? g : g.field));
  const groups = rows
    .map((r) => ({ group: Object.fromEntries(fields.map((f) => [f, r[f] ?? null])), value: numeric(r[metric]) }))
    .filter((g) => g.value !== null);
  const judged = judgeGroups(groups, { mode, condition: alert.condition, threshold: alert.threshold, thresholdHigh: alert.thresholdHigh });
  return {
    value: judged.value,
    noData: groups.length === 0,
    conditionMet: judged.conditionMet,
    mode,
    groupsEvaluated: groups.length,
    groupsMatched: judged.matched.length,
    sample: (mode === 'any' ? judged.matched : groups).slice(0, ALERT_EVENT_GROUP_SAMPLE),
  };
}

/**
 * Validate a rule's metric against the query it will evaluate, at save
 * time. Widget alerts read the widget's effective query; when the
 * dashboard or widget cannot be found the check is left to evaluation
 * (which fails with 404 until the rule points at a real widget).
 */
async function assertMetricForRule({ tenantId, source, query, dashboardId, widgetId, metric }) {
  if (source === 'query') return assertMetricInQuery(metric, query ?? {});
  const params = await widgetParams({ tenantId, dashboardId, widgetId });
  return params ? assertMetricInQuery(metric, params) : metric;
}

/** A widget's effective query, or null when it cannot be found. */
async function widgetParams({ tenantId, dashboardId, widgetId }) {
  if (!dashboardId || !widgetId) return null;
  const dashboard = await dashboardRepository.findById(String(dashboardId), { tenantId }).catch(() => null);
  if (!dashboard) return null;
  const widget = await widgetRepository.findById(String(widgetId), { tenantId, dashboardId: String(dashboardId) }).catch(() => null);
  if (!widget) return null;
  return dashboardService.mergeWidgetQuery({ widget, dashboard });
}

/** Default metric for a new rule: the first output of its query. */
async function resolveDefaultMetric({ tenantId, source, query, dashboardId, widgetId }) {
  if (source === 'query') return defaultMetric(query ?? {});
  const params = await widgetParams({ tenantId, dashboardId, widgetId });
  return params ? defaultMetric(params) : 'count';
}

/** Short, storable failure text for `lastEvaluation.error`. */
function evaluationError(err) {
  if (!(err instanceof ApiError)) return 'The alert could not be evaluated';
  const details = Array.isArray(err.errors)
    ? err.errors.filter((e) => e && e.field).map((e) => `${e.field} ${e.message}`)
    : [];
  return (details.length ? `${err.message}: ${details.join('; ')}` : err.message).slice(0, 1000);
}

async function dispatchNotifications({ tenantId, alert, value, event }) {
  const channels = alert.notification?.channels || ['in_app'];
  const recipients = alert.notification?.recipients || [];
  const userIds = new Set();
  recipients.filter((r) => r.type === 'user').forEach((r) => userIds.add(r.value));
  if (alert.createdBy) userIds.add(alert.createdBy);

  for (const ch of channels) {
    if (ch === 'in_app') {
      // onboarding: users who turned in-app notifications off are skipped.
      const accepting = await notificationService.recipientsAccepting({ tenantId, userIds: [...userIds], channel: 'in_app' });
      for (const uid of accepting) {
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
      // onboarding: tenant users who turned email notifications off are skipped.
      const emails = await notificationService.emailsAccepting({
        tenantId, emails: recipients.filter((r) => r.type === 'email').map((r) => r.value),
      });
      for (const em of emails) {
        try {
          // retention: durable outbox delivery with retries; one message per
          // (event, recipient), so a re-run never mails twice.
          await deliveryService.deliver({
            tenantId: String(tenantId),
            kind: 'alert',
            destination: { type: 'email', to: em },
            payload: { sourceId: String(alert._id), template: 'alert.triggered', variables: { alertName: alert.name, message: event.message } },
            idempotencyKey: `alert:${String(event._id)}:${String(em).toLowerCase()}`,
          });
        } catch {
          /* best-effort: an invalid recipient must not stop other channels */
        }
      }
    }
  }
  // delivery: webhook / Slack / Teams destinations, whatever the channels.
  for (const destinationId of alert.notification?.destinationIds || []) {
    try {
      await deliveryService.deliver({
        tenantId: String(tenantId),
        kind: 'alert',
        destination: { type: 'webhook', destinationId },
        payload: { sourceId: String(alert._id), title: `Alert: ${alert.name}`, text: event.message, data: { alertId: String(alert._id), eventId: String(event._id), value } },
        idempotencyKey: `alert:${String(event._id)}:dest:${destinationId}`,
      });
    } catch {
      /* best-effort: one destination must not stop the others */
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
  metric,
  groupEvaluation = 'total',
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

  // Validate the definition BEFORE consuming quota, so a rejected rule never
  // uses up an alert slot.
  let resolvedQuery = null;
  if (source === 'widget') {
    if (!dashboardId || !widgetId) throw ApiError.badRequest('widget source requires dashboardId and widgetId');
  } else {
    if (!query || !query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    resolvedQuery = sanitizeAlertQuery(query);
  }
  const high = validateBetween(condition, threshold, thresholdHigh);
  const grouping = validateGroupEvaluation(groupEvaluation ?? 'total');
  // The metric must be an output of the query the rule evaluates.
  const ruleSource = { tenantId, source, query: resolvedQuery, dashboardId, widgetId };
  const ruleMetric = metric === undefined || metric === null || metric === ''
    ? await resolveDefaultMetric(ruleSource)
    : await assertMetricForRule({ ...ruleSource, metric });
  const scheduleCron = schedule?.cron || DEFAULT_CRON;
  const scheduleZone = scheduleTimezone(schedule?.timezone);
  assertValidCron(scheduleCron, (m) => ApiError.badRequest(m), scheduleZone ?? 'UTC');

  const notificationObj = {
    channels: notification?.channels && notification.channels.every((c) => ALERT_CHANNELS.includes(c))
      ? notification.channels
      : ['in_app'],
    recipients: notification?.recipients || [],
    template: notification?.template || null,
    // delivery: destination ids owned by the tenant.
    destinationIds: await deliveryService.assertDestinationsOwned(tenantId, notification?.destinationIds || [], 'notification.destinationIds'),
  };

  // Alert-count quota: consumed atomically after validation, given back if
  // the create fails.
  const doc = await usageService.withQuota({ tenantId, metric: 'alerts', by: actorId }, () => alertRepository.createRule({
    tenantId,
    name: name.trim(),
    description: description ?? '',
    enabled: Boolean(enabled),
    source,
    dashboardId: source === 'widget' ? String(dashboardId) : null,
    widgetId: source === 'widget' ? String(widgetId) : null,
    query: source === 'query' ? resolvedQuery : null,
    metric: ruleMetric,
    groupEvaluation: grouping,
    condition,
    threshold,
    thresholdHigh: high,
    schedule: { cron: scheduleCron, timezone: scheduleZone },
    cooldownMinutes: Math.max(0, Number(cooldownMinutes) || 0),
    notification: notificationObj,
    nextEvaluationAt: clock.now(),
    createdBy: actorId,
  }));

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
  if (patch.metric !== undefined) {
    if (typeof patch.metric !== 'string' || !patch.metric.trim()) {
      throw ApiError.badRequest('Invalid alert metric', [{ field: 'metric', message: 'must be a non-empty string' }]);
    }
    updates.metric = patch.metric.trim();
  }
  if (patch.groupEvaluation !== undefined) updates.groupEvaluation = validateGroupEvaluation(patch.groupEvaluation);
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
  if (patch.condition !== undefined || patch.threshold !== undefined || patch.thresholdHigh !== undefined) {
    const condition = updates.condition ?? existing.condition;
    const high = patch.thresholdHigh !== undefined ? patch.thresholdHigh : existing.thresholdHigh;
    updates.thresholdHigh = validateBetween(condition, updates.threshold ?? existing.threshold, high);
  }
  if (patch.cooldownMinutes !== undefined) {
    updates.cooldownMinutes = Math.max(0, Number(patch.cooldownMinutes) || 0);
  }
  if (patch.schedule !== undefined) {
    // `timezone: ''` or null clears the override (follow the workspace zone).
    const timezone = patch.schedule?.timezone !== undefined
      ? scheduleTimezone(patch.schedule.timezone)
      : existing.schedule?.timezone ?? null;
    updates.schedule = {
      cron: patch.schedule?.cron || existing.schedule?.cron || DEFAULT_CRON,
      timezone,
    };
    assertValidCron(updates.schedule.cron, (m) => ApiError.badRequest(m), timezone ?? 'UTC');
    updates.nextEvaluationAt = await projectNextEvaluation(tenantId, updates.schedule);
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
      // delivery: destination ids owned by the tenant.
      destinationIds: await deliveryService.assertDestinationsOwned(tenantId, patch.notification.destinationIds || [], 'notification.destinationIds'),
    };
  }

  if (Object.keys(updates).length === 0) return existing;
  // A changed metric or query is held to the metric contract again.
  if (['metric', 'query', 'source', 'dashboardId', 'widgetId'].some((k) => updates[k] !== undefined)) {
    const source = updates.source ?? existing.source;
    await assertMetricForRule({
      tenantId,
      source,
      query: updates.query ?? existing.query,
      dashboardId: updates.dashboardId ?? existing.dashboardId,
      widgetId: updates.widgetId ?? existing.widgetId,
      metric: updates.metric ?? existing.metric,
    });
  }
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
  if (!(await alertRepository.removeRule(alertId, actorId))) throw ApiError.notFound('Alert not found');
  await usageService.release({ tenantId, metric: 'alerts', requested: 1, by: actorId });
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
 * Evaluate a single alert rule: measure the metric (see METRIC CONTRACT),
 * compare it to the threshold, respect the cooldown (see COOLDOWN), record
 * the outcome and dispatch notifications when it triggers.
 *
 * Every evaluation projects and stores the next evaluation BEFORE any side
 * effect, whatever the outcome. A rule whose query or metric cannot be
 * evaluated records `lastEvaluation.outcome = 'failed'` and the error is
 * rethrown (the HTTP caller sees the typed 4xx).
 *
 * @returns {Promise<{ triggered: boolean, suppressed: boolean, value: number|null,
 *   conditionMet: boolean, noData: boolean, outcome: string, event: object|null,
 *   groupsEvaluated?: number|null, groupsMatched?: number|null }>}
 */
export async function evaluate({ tenantId, alertId, triggeredBy = 'manual', runBy = null } = {}) {
  const alert = await alertRepository.findRuleById(alertId, { tenantId });
  if (!alert) throw ApiError.notFound('Alert not found');
  if (alert.enabled === false) {
    return { triggered: false, suppressed: false, value: null, conditionMet: false, noData: false, outcome: 'disabled', event: null, disabled: true };
  }

  const now = clock.now();
  // Project the next run BEFORE any side effect, in the schedule's
  // effective time zone (see projectNextEvaluation for the fallback).
  const nextEvaluationAt = await projectNextEvaluation(tenantId, alert.schedule, now);

  let m;
  try {
    const { datasetId, params } = await resolveAlertQuery({ tenantId, alert });
    const startedAt = Date.now();
    m = await measure({ tenantId, datasetId, params, alert, now });
    // ai-catalogue: attribution of the evaluation (the rule's query, its window and datasets).
    await recordRun({
      tenantId,
      source: 'alert',
      sourceId: String(alert._id),
      actorId: runBy ?? null,
      query: { ...params, connectorIds: [datasetId], now },
      result: { rowCount: m.groupsEvaluated ?? 1, total: m.groupsEvaluated ?? null },
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    // A rule whose query or metric cannot run (e.g. rejected by the strict
    // contract) still moves to its next slot instead of being retried
    // every tick, and says why it failed.
    await alertRepository.markEvaluated(alert._id, {
      lastEvaluatedAt: now,
      nextEvaluationAt,
      lastEvaluation: { at: now, outcome: 'failed', value: null, groupsEvaluated: null, groupsMatched: null, error: evaluationError(err) },
    });
    throw err;
  }

  const { value, conditionMet, noData } = m;
  const groups = m.mode === 'total' ? {} : { groupsEvaluated: m.groupsEvaluated, groupsMatched: m.groupsMatched };
  const record = (outcome) => ({ at: now, outcome, value, groupsEvaluated: m.groupsEvaluated, groupsMatched: m.groupsMatched, error: null });
  const describe = () => {
    const base = `${alert.metric} = ${value} ${alert.condition} ${alert.threshold}${alert.condition === 'between' ? `..${alert.thresholdHigh}` : ''}`;
    return m.mode === 'total' ? base : `${base} (${m.groupsMatched} of ${m.groupsEvaluated} groups, ${m.mode})`;
  };
  const eventData = (status, message) => ({
    tenantId,
    alertId: alert._id,
    name: alert.name,
    triggeredAt: now,
    value,
    condition: alert.condition,
    threshold: alert.threshold,
    thresholdHigh: alert.thresholdHigh,
    status,
    message,
    runBy,
    details: m.mode === 'total' ? null : { mode: m.mode, groupsEvaluated: m.groupsEvaluated, groupsMatched: m.groupsMatched, sample: m.sample },
  });

  if (!conditionMet) {
    const outcome = noData ? 'no_data' : 'not_met';
    await alertRepository.markEvaluated(alert._id, { lastEvaluatedAt: now, nextEvaluationAt, lastEvaluation: record(outcome) });
    return { triggered: false, suppressed: false, value, conditionMet: false, noData, outcome, event: null, ...groups };
  }

  // Claim the trigger first (atomic, cooldown-aware) so a concurrent
  // evaluation or a failure while notifying can never fire it twice.
  const claimed = await alertRepository.claimTrigger({
    id: alert._id,
    now,
    cooldownMs: Math.max(0, Number(alert.cooldownMinutes) || 0) * 60000,
    nextEvaluationAt,
    lastEvaluation: record('triggered'),
  });
  if (!claimed) {
    await alertRepository.markEvaluated(alert._id, { lastEvaluatedAt: now, nextEvaluationAt, lastEvaluation: record('suppressed') });
    const event = await alertRepository.createEvent(eventData(
      'suppressed',
      `Alert "${alert.name}" condition met but suppressed (cooldown ${alert.cooldownMinutes} min): ${describe()}`,
    ));
    return { triggered: false, suppressed: true, value, conditionMet: true, noData: false, outcome: 'suppressed', event, ...groups };
  }

  const event = await alertRepository.createEvent(eventData('triggered', `Alert "${alert.name}" triggered: ${describe()}`));
  await dispatchNotifications({ tenantId, alert, value, event });
  return { triggered: true, suppressed: false, value, conditionMet: true, noData: false, outcome: 'triggered', event, ...groups };
}

/**
 * Scheduler scan: claim and evaluate every enabled alert whose next run is due.
 *
 * Each candidate is claimed with one atomic update that advances
 * `nextEvaluationAt` (projected in the schedule's effective time zone, like
 * `evaluate`) and takes a short lease, so concurrent scans evaluate each due
 * rule exactly once per tick, and a rule whose evaluation throws is not due
 * again until its next cron slot. Rules of tenants that are not active are
 * claimed (their schedule moves on) but not evaluated.
 */
export async function evaluateDue({ now = clock.now(), limit = 100, owner = newClaimOwner() } = {}) {
  const due = await alertRepository.findDueRules({ now, limit });
  const isActive = createTenantStatusCache();
  const leaseMs = claimLeaseMs();
  let claimed = 0;
  let evaluated = 0;
  let skippedInactive = 0;
  let failed = 0;
  let suppressed = 0;
  const triggered = [];
  // One workspace time zone lookup per tenant per scan.
  const zones = new Map();
  const workspaceZone = (tenantId) => {
    const key = String(tenantId);
    if (!zones.has(key)) zones.set(key, getWorkspaceTimezone(tenantId));
    return zones.get(key);
  };
  for (const rule of due) {
    const next = await projectNextEvaluation(rule.tenantId, rule.schedule, now, workspaceZone)
      .catch(() => safeNextRun(rule.schedule?.cron || DEFAULT_CRON, now, DEFAULT_CRON));
    const claim = await alertRepository.claimDueRule({
      id: rule._id, expectedNextEvaluationAt: rule.nextEvaluationAt ?? null, nextEvaluationAt: next, owner, leaseMs, now,
    }).catch(() => null);
    if (!claim) continue; // another scan claimed it first
    claimed += 1;
    try {
      if (!(await isActive(rule.tenantId))) {
        skippedInactive += 1;
        continue;
      }
      const result = await evaluate({ tenantId: rule.tenantId, alertId: String(rule._id), triggeredBy: 'schedule' });
      evaluated += 1;
      if (result.triggered) triggered.push(String(rule._id));
      if (result.suppressed) suppressed += 1;
    } catch {
      failed += 1; /* continue with the next due alert */
    } finally {
      await alertRepository.releaseRuleClaim(rule._id, owner).catch(() => {});
    }
  }
  return { scanned: due.length, claimed, evaluated, triggered: triggered.length, suppressed, skippedInactive, failed };
}

/**
 * Re-project `nextEvaluationAt` for a tenant's enabled rules that follow the
 * workspace time zone. Called after the workspace time zone changes.
 */
export async function reprojectSchedules({ tenantId, now = clock.now() } = {}) {
  let updated = 0;
  for (let page = 1; ; page += 1) {
    const result = await alertRepository.listRules({
      tenantId,
      filter: { enabled: true, 'schedule.timezone': { $in: [null, ''] } },
      page,
      limit: 100,
    });
    for (const rule of result.docs) {
      await alertRepository.updateRule(String(rule._id), {
        nextEvaluationAt: await projectNextEvaluation(tenantId, rule.schedule, now),
      });
      updated += 1;
    }
    if (page >= (result.pages || 1)) break;
  }
  return { updated };
}

/**
 * Read-only audit of the metric contract over stored rules: lists every
 * rule whose `metric` is not an output of its (current) query, and every
 * rule whose query cannot be resolved (deleted dataset or widget, query
 * the strict contract rejects). Such rules fail their evaluations with a
 * recorded error; this tells an operator which ones to fix. Writes nothing.
 *
 * @param {Object} [opts]
 * @param {string[]|null} [opts.tenantIds]
 * @param {(finding: object) => void} [opts.onFinding]
 * @returns {Promise<{ checked: number, invalidMetric: number, unresolvable: number }>}
 */
export async function auditMetrics({ tenantIds = null, onFinding = () => {} } = {}) {
  const summary = { checked: 0, invalidMetric: 0, unresolvable: 0 };
  for await (const rule of alertRepository.cursorRules({ tenantIds })) {
    summary.checked += 1;
    const base = { tenantId: String(rule.tenantId), alertId: String(rule._id), name: rule.name, metric: rule.metric, enabled: rule.enabled !== false };
    let params;
    try {
      ({ params } = await resolveAlertQuery({ tenantId: rule.tenantId, alert: rule }));
    } catch (err) {
      summary.unresolvable += 1;
      onFinding({ ...base, problem: 'unresolvable', reason: evaluationError(err) });
      continue;
    }
    const outputs = queryOutputs(params);
    if (!outputs.includes(rule.metric)) {
      summary.invalidMetric += 1;
      onFinding({ ...base, problem: 'invalid_metric', outputs });
    }
  }
  return summary;
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
  reprojectSchedules,
  measure,
  auditMetrics,
  queryOutputs,
  assertMetricInQuery,
  compare,
  judgeGroups,
  ALERT_ERROR_CODES,
  ALERT_MAX_GROUPS,
  _meta: { module: 'alerts' },
};
