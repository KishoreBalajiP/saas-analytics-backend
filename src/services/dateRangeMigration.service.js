/**
 * Legacy date-range migration (roadmap 1.2, deploy step).
 *
 * WHY IT EXISTS
 *   The analytics query contract now requires `dateRange.field` (the date
 *   column a window applies to) and rejects relative presets that also
 *   carry from/to. Definitions saved before that change filtered on
 *   ingestion time implicitly. This migration makes that explicit
 *   (`field: 'ingestedAt'`), so existing dashboards, widgets, reports and
 *   alerts keep their current numbers and show their owners which column
 *   they filter on; owners can then switch to a business date column.
 *
 * WHAT IT CHANGES (dateRange objects only)
 *   dashboards.filters.dateRange, widgets.query.dateRange,
 *   reports.query.dateRange, reports.filters.dateRange,
 *   alertrules.query.dateRange:
 *   - missing `field`                -> 'ingestedAt'
 *   - relative preset with from/to   -> from/to removed (they were ignored)
 *   - Date / non-ISO from/to         -> ISO-8601 string (unparseable bound removed)
 *   - no preset and no bounds        -> dateRange removed (it filtered nothing)
 *   - unknown keys                   -> removed
 *   Report and alert windows frozen to absolute from/to by the old code stay
 *   absolute (their original preset cannot be recovered); owners should
 *   re-select a relative preset.
 *
 * SCHEDULE TIME ZONES (separate step, `migrateLegacyScheduleTimezones`)
 *   Reports and alerts used to store `schedule.timezone: 'UTC'` by default
 *   (model default, and the report form's prefilled value) while their cron
 *   always ran in UTC. An empty zone now means "follow the workspace time
 *   zone". This step clears the stored default so existing schedules follow
 *   the workspace zone, and re-projects their next run. For a workspace
 *   still on UTC nothing moves. An explicit choice of UTC cannot be told
 *   apart from the old default, so the script can skip this step
 *   (`--keep-utc-schedules`).
 *
 * SAFETY
 *   Dry run by default: reports what would change and which definitions
 *   would still be rejected by the contract for other reasons. `apply`
 *   writes only the dateRange paths listed above (and, for the schedule
 *   step, `schedule.timezone` and the re-projected next run).
 */

import { Dashboard } from '../models/Dashboard.js';
import { Widget } from '../models/Widget.js';
import { Report } from '../models/Report.js';
import { AlertRule } from '../models/AlertRule.js';
import { QUERY_FIELDS } from '../models/Widget.js';
import { DATE_PRESETS, FILTER_ENVELOPE_KEYS, validateQuery } from './analytics.engine.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoBound(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'string' && ISO_RE.test(value.trim())) return value.trim();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Upgrade one stored dateRange. Returns `{ value, changed }`, where
 * `value === undefined` means the dateRange should be removed.
 */
export function upgradeDateRange(dateRange) {
  if (dateRange === undefined || dateRange === null) return { value: dateRange, changed: false };
  if (typeof dateRange !== 'object' || Array.isArray(dateRange)) return { value: undefined, changed: true };
  const out = {};
  out.field = typeof dateRange.field === 'string' && dateRange.field ? dateRange.field : 'ingestedAt';
  const preset = DATE_PRESETS.includes(dateRange.preset) ? dateRange.preset : undefined;
  if (preset) out.preset = preset;
  if (!preset || preset === 'custom') {
    const from = isoBound(dateRange.from);
    const to = isoBound(dateRange.to);
    if (from) out.from = from;
    if (to) out.to = to;
    if (!from && !to) return { value: undefined, changed: true };
  }
  const changed = JSON.stringify(out) !== JSON.stringify(dateRange);
  return { value: out, changed };
}

/** Collections and the dateRange paths they hold, plus how to re-validate them. */
const TARGETS = [
  { name: 'dashboards', model: Dashboard, paths: [{ path: 'filters', keys: FILTER_ENVELOPE_KEYS }] },
  { name: 'widgets', model: Widget, paths: [{ path: 'query', keys: QUERY_FIELDS }] },
  {
    name: 'reports',
    model: Report,
    paths: [{ path: 'query', keys: QUERY_FIELDS, extra: ['datasetId'] }, { path: 'filters', keys: FILTER_ENVELOPE_KEYS }],
  },
  { name: 'alerts', model: AlertRule, paths: [{ path: 'query', keys: QUERY_FIELDS, extra: ['datasetId'] }] },
];

function stillValid(container, { keys, extra = [] }) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return true;
  try {
    const extras = Object.fromEntries(extra.map((key) => [key, (v) => v]));
    validateQuery(container, { keys, extra: extras });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan (and optionally fix) every stored analytics definition.
 *
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<Object<string, { scanned: number, changed: number, stillInvalid: string[] }>>}
 */
export async function migrateLegacyDateRanges({ dryRun = true } = {}) {
  const report = {};
  for (const target of TARGETS) {
    const summary = { scanned: 0, changed: 0, stillInvalid: [] };
    // Native driver: no tenant-scope or audit middleware, deleted rows skipped.
    const cursor = target.model.collection.find({ deletedAt: null });
    for await (const doc of cursor) {
      summary.scanned += 1;
      const $set = {};
      const $unset = {};
      let invalid = false;
      for (const spec of target.paths) {
        const container = doc[spec.path];
        if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
        const { value, changed } = upgradeDateRange(container.dateRange);
        const upgraded = { ...container };
        if (changed) {
          if (value === undefined) {
            $unset[`${spec.path}.dateRange`] = '';
            delete upgraded.dateRange;
          } else {
            $set[`${spec.path}.dateRange`] = value;
            upgraded.dateRange = value;
          }
        }
        if (!stillValid(upgraded, spec)) invalid = true;
      }
      if (Object.keys($set).length || Object.keys($unset).length) {
        summary.changed += 1;
        if (!dryRun) {
          const update = {};
          if (Object.keys($set).length) update.$set = $set;
          if (Object.keys($unset).length) update.$unset = $unset;
          await target.model.collection.updateOne({ _id: doc._id }, update);
        }
      }
      if (invalid) summary.stillInvalid.push(String(doc._id));
    }
    report[target.name] = summary;
  }
  return report;
}

/** Stored zone values that were the pre-1.2 default (cron always ran in UTC). */
const LEGACY_DEFAULT_ZONES = ['UTC', 'utc', 'Etc/UTC'];

/**
 * Clear legacy default schedule zones on reports and alert rules so they
 * follow the workspace time zone, then re-project their next run.
 *
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<Object<string, { scanned: number, changed: number, stillInvalid: string[] }>>}
 *   `scanned` = schedules still on the legacy default.
 */
export async function migrateLegacyScheduleTimezones({ dryRun = true } = {}) {
  // Imported lazily: the services pull in the HTTP-free service graph only
  // when this step actually runs.
  const [reportService, alertService] = await Promise.all([
    import('./report.service.js'),
    import('./alert.service.js'),
  ]);
  const targets = [
    { name: 'reportSchedules', model: Report, reproject: reportService.reprojectSchedules },
    { name: 'alertSchedules', model: AlertRule, reproject: alertService.reprojectSchedules },
  ];
  const report = {};
  for (const { name, model, reproject } of targets) {
    const filter = { deletedAt: null, 'schedule.timezone': { $in: LEGACY_DEFAULT_ZONES } };
    const docs = await model.collection.find(filter, { projection: { _id: 1, tenantId: 1 } }).toArray();
    let changed = docs.length;
    if (!dryRun && docs.length) {
      const res = await model.collection.updateMany(
        { _id: { $in: docs.map((d) => d._id) } },
        { $set: { 'schedule.timezone': null } },
      );
      changed = res.modifiedCount;
      for (const tenantId of new Set(docs.map((d) => String(d.tenantId)))) {
        await reproject({ tenantId });
      }
    }
    report[name] = { scanned: docs.length, changed, stillInvalid: [] };
  }
  return report;
}

export default { migrateLegacyDateRanges, migrateLegacyScheduleTimezones, upgradeDateRange };
