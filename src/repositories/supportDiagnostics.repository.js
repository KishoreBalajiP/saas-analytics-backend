/**
 * Support Diagnostics Repository (roadmap 2.3 - sanitised diagnostics).
 *
 * PURPOSE
 *   Read-only, tenant-scoped aggregates the support diagnostics endpoint
 *   needs: counts, statuses and timings. It deliberately projects only
 *   operational fields so customer data (rows, configs, emails, file names,
 *   field mappings) never leaves the database through this path.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - countUsersByStatus / countActiveSessions
 *   - listConnectorStates / countConnectorsByStatus
 *   - listRecentSyncRuns / countFailedSyncRuns
 *   - requestStatusCounts / topErrorPaths (access log)
 *   - countBroken (widgets, reports, alerts)
 *
 * CODING GUIDELINES
 *   - Every query filters by `tenantId` explicitly.
 *   - `select()` lists the allowed fields; never return whole documents.
 */

import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { Connector } from '../models/Connector.js';
import { SyncRun } from '../models/SyncRun.js';
import { AccessLog } from '../models/AccessLog.js';
import { Widget } from '../models/Widget.js';
import { Report } from '../models/Report.js';
import { AlertRule } from '../models/AlertRule.js';

/** Fields of a connector that are safe to show support (no config, token or mapping). */
const CONNECTOR_FIELDS = 'type name status syncStatus lastSyncedAt syncRequestedAt lastError errorCount dataVersion createdAt updatedAt';

/** Fields of a sync run that are safe to show support (no file name, no requester). */
const SYNC_RUN_FIELDS = 'connectorId trigger jobType status attempts maxAttempts queuedAt startedAt finishedAt durationMs rows error createdAt';

/** Users per status (`{ active: 3, invited: 1 }`), soft-deleted users excluded. */
export const countUsersByStatus = async (tenantId) => {
  const rows = await User.aggregate([
    { $match: { tenantId: String(tenantId), deletedAt: null } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id ?? 'unknown'), r.count]));
};

/** Live sessions in the tenant (support sessions included). */
export const countActiveSessions = (tenantId, now = new Date()) =>
  Session.countDocuments({ tenantId: String(tenantId), status: 'active', expiresAt: { $gt: now } });

/** The most recently changed connectors, operational fields only. */
export const listConnectorStates = (tenantId, { limit = 50 } = {}) =>
  Connector.find({ tenantId: String(tenantId) })
    .select(CONNECTOR_FIELDS)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

/** Connectors per status (`{ active: 2, error: 1 }`). */
export const countConnectorsByStatus = async (tenantId) => {
  const rows = await Connector.aggregate([
    { $match: { tenantId: String(tenantId), deletedAt: null } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id ?? 'unknown'), r.count]));
};

/** Latest sync runs across the tenant's connectors. */
export const listRecentSyncRuns = (tenantId, { limit = 20 } = {}) =>
  SyncRun.find({ tenantId: String(tenantId) })
    .select(SYNC_RUN_FIELDS)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

/** Sync runs that failed or were abandoned since `since`. */
export const countFailedSyncRuns = (tenantId, since) =>
  SyncRun.countDocuments({
    tenantId: String(tenantId),
    status: { $in: ['failed', 'abandoned'] },
    createdAt: { $gte: since },
  });

/** Authenticated requests of the tenant since `since`, grouped by status code. */
export const requestStatusCounts = async (tenantId, since) => {
  const rows = await AccessLog.aggregate([
    { $match: { tenantId: String(tenantId), occurredAt: { $gte: since } } },
    { $group: { _id: '$statusCode', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ statusCode: Number(r._id), count: r.count }));
};

/** Paths that answered 4xx/5xx most often since `since` (raw; caller strips query strings). */
export const topErrorPaths = (tenantId, since, { limit = 10 } = {}) =>
  AccessLog.aggregate([
    { $match: { tenantId: String(tenantId), occurredAt: { $gte: since }, statusCode: { $gte: 400 } } },
    { $group: { _id: { path: '$path', statusCode: '$statusCode' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

/** Widgets, reports and alert rules marked broken by a deleted dependency. */
export const countBroken = async (tenantId) => {
  const filter = { tenantId: String(tenantId), brokenAt: { $ne: null } };
  const [widgets, reports, alerts] = await Promise.all([
    Widget.countDocuments(filter),
    Report.countDocuments(filter),
    AlertRule.countDocuments(filter),
  ]);
  return { widgets, reports, alerts };
};

export default {
  countUsersByStatus,
  countActiveSessions,
  listConnectorStates,
  countConnectorsByStatus,
  listRecentSyncRuns,
  countFailedSyncRuns,
  requestStatusCounts,
  topErrorPaths,
  countBroken,
  _meta: { leanReturns: true, tenancy: 'tenant', readsOnly: true },
};
