/**
 * Connector dependants repository (connector delete cascade).
 *
 * PURPOSE
 *   Data access for everything that READS a connector: widgets (by
 *   `datasetId`), and reports / alerts (by `query.datasetId` for query
 *   sources, or through one of those widgets for widget sources).
 *
 * RESPONSIBILITY (database access only)
 *   - `markBrokenForConnector` - flag every live dependant of a connector as
 *     broken with a reason, and stop the scheduled ones: alerts are disabled
 *     and report schedules switched off, so the schedulers stop failing on
 *     them every tick. Reports whose schedule was on are counted
 *     (`reportSchedulesStopped`) so the caller can give back their
 *     scheduled-report quota.
 *
 * TENANCY
 *   Every query is scoped by `tenantId` (explicit) and excludes
 *   soft-deleted documents.
 */

import mongoose from 'mongoose';
import { Widget } from '../models/Widget.js';
import { Report } from '../models/Report.js';
import { AlertRule } from '../models/AlertRule.js';

/**
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {string} input.reason - e.g. `CONNECTOR_DELETED`.
 * @param {Date} [input.at]
 * @returns {Promise<{ widgets: number, reports: number, reportSchedulesStopped: number, alerts: number, widgetIds: string[] }>}
 */
export async function markBrokenForConnector({ tenantId, connectorId, reason, at = new Date() } = {}) {
  if (!tenantId) throw new Error('connectorDependants: tenantId is required');
  if (!connectorId) throw new Error('connectorDependants: connectorId is required');
  const cid = String(connectorId);
  const connectorRef = `connector:${cid}`;
  const live = { tenantId, deletedAt: null };
  // `query` is a Mixed field: services store the id as a string, but match
  // an ObjectId too so no dependant is missed.
  const datasetMatch = mongoose.isValidObjectId(cid) ? { $in: [cid, new mongoose.Types.ObjectId(cid)] } : cid;

  const widgets = await Widget.find({ ...live, datasetId: cid }, { _id: 1 }).lean();
  const widgetIds = widgets.map((w) => String(w._id));
  let widgetCount = 0;
  if (widgetIds.length > 0) {
    const res = await Widget.updateMany(
      { ...live, _id: { $in: widgetIds } },
      { $set: { brokenAt: at, brokenReason: reason, brokenRef: connectorRef } },
    );
    widgetCount = res.modifiedCount ?? 0;
  }

  // Reports are updated in two steps: those whose schedule is on first (their
  // count is the scheduled-report quota to give back), then the rest. The
  // second step skips documents the first one just marked (`brokenAt: at`),
  // so each report is counted once.
  const markReports = async (filter, update) => {
    const stopped = await Report.updateMany({ ...filter, 'schedule.enabled': true }, update);
    const rest = await Report.updateMany({ ...filter, brokenAt: { $ne: at } }, update);
    return { stopped: stopped.modifiedCount ?? 0, modifiedCount: (stopped.modifiedCount ?? 0) + (rest.modifiedCount ?? 0) };
  };

  // Query-sourced reports / alerts that name the connector directly.
  const reportQuery = await markReports(
    { ...live, source: 'query', 'query.datasetId': datasetMatch },
    { $set: { brokenAt: at, brokenReason: reason, brokenRef: connectorRef, 'schedule.enabled': false, nextRunAt: null } },
  );
  const alertQuery = await AlertRule.updateMany(
    { ...live, source: 'query', 'query.datasetId': datasetMatch },
    { $set: { brokenAt: at, brokenReason: reason, brokenRef: connectorRef, enabled: false, nextEvaluationAt: null } },
  );

  // Widget-sourced reports / alerts: broken through the widget.
  let reportWidget = { modifiedCount: 0, stopped: 0 };
  let alertWidget = { modifiedCount: 0 };
  if (widgetIds.length > 0) {
    const brokenRef = { $concat: ['widget:', { $toString: '$widgetId' }] };
    reportWidget = await markReports(
      { ...live, source: 'widget', widgetId: { $in: widgetIds } },
      [{ $set: { brokenAt: at, brokenReason: reason, brokenRef, 'schedule.enabled': false, nextRunAt: null } }],
    );
    alertWidget = await AlertRule.updateMany(
      { ...live, source: 'widget', widgetId: { $in: widgetIds } },
      [{ $set: { brokenAt: at, brokenReason: reason, brokenRef, enabled: false, nextEvaluationAt: null } }],
    );
  }

  return {
    widgets: widgetCount,
    reports: (reportQuery.modifiedCount ?? 0) + (reportWidget.modifiedCount ?? 0),
    reportSchedulesStopped: reportQuery.stopped + reportWidget.stopped,
    alerts: (alertQuery.modifiedCount ?? 0) + (alertWidget.modifiedCount ?? 0),
    widgetIds,
  };
}

export default {
  markBrokenForConnector,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
