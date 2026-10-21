/**
 * Security Detection Source Repository (roadmap 2.6).
 *
 * PURPOSE
 *   The READ-ONLY event sources of the platform security detection rules
 *   (`services/securityDetection/rules/`): authentication attempts, audit
 *   and security events, the access trace, audit/access-log exports, sync
 *   runs, API keys and the identities alerts refer to.
 *
 * CODING GUIDELINES
 *   - Read only. Nothing here writes; the detector never mutates evidence.
 *   - Platform-wide on purpose (the detector watches every tenant): no
 *     tenant scope is set, and soft-deleted API keys / users / admins are
 *     included where a rule needs them (a deleted key used again is itself
 *     a signal).
 *   - Every list is bounded by a time range AND a row limit, sorted oldest
 *     first, projected to the fields the rules use, and served by an index:
 *       LoginAttempt { success, occurredAt } (detection) / { actorId, occurredAt }
 *       AuditLog     { module, action, occurredAt }
 *       AccessLog    { statusCode, occurredAt } / { path, occurredAt } / { actorId, occurredAt }
 *       AuditExport  { status, createdAt }
 *       SyncRun      { status, finishedAt } (detection)
 *   - Reads return PLAIN objects (`.lean()`), including fields newer writers
 *     add (for example `metadata` on security events).
 */

import { LoginAttempt } from '../models/LoginAttempt.js';
import { AuditLog } from '../models/AuditLog.js';
import { AccessLog } from '../models/AccessLog.js';
import { AuditExport, EXPORT_STATUSES } from '../models/AuditExport.js';
import { SyncRun } from '../models/SyncRun.js';
import { ApiKey } from '../models/ApiKey.js';
import { User } from '../models/User.js';
import { Admin } from '../models/Admin.js';

export const DEFAULT_LIMIT = 50000;

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function range(from, to) {
  const window = {};
  if (from) window.$gt = from;
  if (to) window.$lte = to;
  return window;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prefixClauses(prefixes) {
  return prefixes.map((prefix) => ({ path: { $regex: `^${escapeRegex(prefix)}` } }));
}

function objectIds(ids) {
  return [...new Set((ids ?? []).map(String))].filter((id) => OBJECT_ID_RE.test(id));
}

/* ----------------------------- login attempts ---------------------------- */

const ATTEMPT_FIELDS = 'actorId actorType email tenantId ip success reason occurredAt';

/** Attempts in (from, to], optionally filtered by outcome and portal. */
export const listLoginAttempts = ({ from, to, success, actorType, limit = DEFAULT_LIMIT } = {}) => {
  const filter = { occurredAt: range(from, to) };
  if (success !== undefined) filter.success = Boolean(success);
  if (actorType) filter.actorType = String(actorType);
  return LoginAttempt.find(filter).select(ATTEMPT_FIELDS).sort({ occurredAt: 1 }).limit(limit).lean();
};

/**
 * The most recent successful admin sign-in in [since, before), optionally
 * from one IP (first-seen IP rule).
 */
export const findPriorAdminLogin = ({ actorId, ip, since, before }) => {
  const filter = {
    actorId: String(actorId),
    actorType: 'admin',
    success: true,
    occurredAt: { $gte: since, $lt: before },
  };
  if (ip !== undefined) filter.ip = String(ip);
  return LoginAttempt.findOne(filter).select(ATTEMPT_FIELDS).sort({ occurredAt: -1 }).lean();
};

/* ------------------------------ audit events ----------------------------- */

/**
 * Audit / security events matching any `{ module, action }` pair in
 * (from, to]. `extra` narrows further (safe, code-built filters only).
 */
export const listAuditEvents = ({ pairs, from, to, extra = {}, limit = DEFAULT_LIMIT }) => {
  if (!pairs?.length) return Promise.resolve([]);
  const filter = {
    $or: pairs.map(({ module, action }) => ({ module: String(module), action: String(action) })),
    occurredAt: range(from, to),
    ...extra,
  };
  return AuditLog.find(filter).sort({ occurredAt: 1 }).limit(limit).lean();
};

/** The most recent event matching the pairs in [since, before). */
export const findLatestAuditEvent = ({ pairs, since, before, extra = {} }) => {
  if (!pairs?.length) return Promise.resolve(null);
  const filter = {
    $or: pairs.map(({ module, action }) => ({ module: String(module), action: String(action) })),
    occurredAt: { $gte: since, $lt: before },
    ...extra,
  };
  return AuditLog.findOne(filter).sort({ occurredAt: -1 }).lean();
};

/** Count events matching the pairs in [since, before). */
export const countAuditEvents = ({ pairs, since, before, extra = {} }) => {
  if (!pairs?.length) return Promise.resolve(0);
  return AuditLog.countDocuments({
    $or: pairs.map(({ module, action }) => ({ module: String(module), action: String(action) })),
    occurredAt: { $gte: since, $lt: before },
    ...extra,
  });
};

/* ------------------------------- access log ------------------------------ */

const ACCESS_FIELDS = 'actorType actorId tenantId method path statusCode latencyMs ip occurredAt';

/** Access-log rows with one status code in (from, to]. */
export const listAccessByStatus = ({ statusCode, from, to, limit = DEFAULT_LIMIT }) =>
  AccessLog.find({ statusCode: Number(statusCode), occurredAt: range(from, to) })
    .select(ACCESS_FIELDS)
    .sort({ occurredAt: 1 })
    .limit(limit)
    .lean();

/**
 * Access-log rows under any of the path prefixes in (from, to], with
 * optional method, minimum latency and maximum status filters.
 */
export const listAccessByPath = ({
  prefixes, from, to, method, minLatencyMs, maxStatusCode, limit = DEFAULT_LIMIT,
}) => {
  if (!prefixes?.length) return Promise.resolve([]);
  const filter = { $or: prefixClauses(prefixes), occurredAt: range(from, to) };
  if (method) filter.method = String(method).toUpperCase();
  if (minLatencyMs !== undefined) filter.latencyMs = { $gte: Number(minLatencyMs) };
  if (maxStatusCode !== undefined) filter.statusCode = { $lte: Number(maxStatusCode) };
  return AccessLog.find(filter).select(ACCESS_FIELDS).sort({ occurredAt: 1 }).limit(limit).lean();
};

/** Count one actor's access-log rows under the prefixes in [since, before). */
export const countAccessForActor = ({ actorId, prefixes, since, before, method, maxStatusCode }) => {
  const filter = {
    actorId: String(actorId),
    occurredAt: { $gte: since, $lt: before },
    $or: prefixClauses(prefixes ?? []),
  };
  if (!prefixes?.length) delete filter.$or;
  if (method) filter.method = String(method).toUpperCase();
  if (maxStatusCode !== undefined) filter.statusCode = { $lte: Number(maxStatusCode) };
  return AccessLog.countDocuments(filter);
};

/* ------------------------------- exports -------------------------------- */

const EXPORT_FIELDS = 'exportId kind tenantId requestedBy format status recordCount createdAt';

/** Audit / access-log export requests created in (from, to]. */
export const listAuditExports = ({ from, to, limit = DEFAULT_LIMIT }) =>
  AuditExport.find({ status: { $in: [...EXPORT_STATUSES] }, createdAt: range(from, to) })
    .select(EXPORT_FIELDS)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

/** Count one requester's export requests in [since, before). */
export const countAuditExportsFor = ({ requestedBy, since, before }) =>
  AuditExport.countDocuments({
    status: { $in: [...EXPORT_STATUSES] },
    requestedBy: String(requestedBy),
    createdAt: { $gte: since, $lt: before },
  });

/* ------------------------------- sync runs ------------------------------- */

const SYNC_FIELDS = 'tenantId connectorId trigger status error finishedAt';

/** Failed sync runs with one of `codes` that finished in (from, to]. */
export const listFailedSyncRuns = ({ from, to, codes, limit = DEFAULT_LIMIT }) =>
  SyncRun.find({
    status: 'failed',
    finishedAt: range(from, to),
    'error.code': { $in: (codes ?? []).map(String) },
  })
    .select(SYNC_FIELDS)
    .sort({ finishedAt: 1 })
    .limit(limit)
    .lean();

/* ------------------------------ identities ------------------------------- */

/** API keys by public prefix (revoked and deleted included). Never secrets. */
export const findApiKeysByPrefixes = (prefixes) => {
  const list = [...new Set((prefixes ?? []).map(String))];
  if (list.length === 0) return Promise.resolve([]);
  return ApiKey.find({ prefix: { $in: list } })
    .setOptions({ includeDeleted: true })
    .select('prefix name tenantId status revokedAt deletedAt')
    .lean();
};

/** API keys by id (revoked and deleted included). Never secrets. */
export const findApiKeysByIds = (ids) => {
  const list = objectIds(ids);
  if (list.length === 0) return Promise.resolve([]);
  return ApiKey.find({ _id: { $in: list } })
    .setOptions({ includeDeleted: true })
    .select('prefix name tenantId status revokedAt deletedAt')
    .lean();
};

/** Users by id (email + tenant only). */
export const findUsersByIds = (ids) => {
  const list = objectIds(ids);
  if (list.length === 0) return Promise.resolve([]);
  return User.find({ _id: { $in: list } }).setOptions({ includeDeleted: true }).select('email tenantId').lean();
};

/** Admins by id (email + type only). */
export const findAdminsByIds = (ids) => {
  const list = objectIds(ids);
  if (list.length === 0) return Promise.resolve([]);
  return Admin.find({ _id: { $in: list } }).setOptions({ includeDeleted: true }).select('email adminType status').lean();
};

/** Admins whose email is one of `emails` (admin-owned tenant check). */
export const findAdminsByEmails = (emails) => {
  const list = [...new Set((emails ?? []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (list.length === 0) return Promise.resolve([]);
  return Admin.find({ email: { $in: list } }).setOptions({ includeDeleted: true }).select('email adminType status').lean();
};

export default {
  DEFAULT_LIMIT,
  listLoginAttempts,
  findPriorAdminLogin,
  listAuditEvents,
  findLatestAuditEvent,
  countAuditEvents,
  listAccessByStatus,
  listAccessByPath,
  countAccessForActor,
  listAuditExports,
  countAuditExportsFor,
  listFailedSyncRuns,
  findApiKeysByPrefixes,
  findApiKeysByIds,
  findUsersByIds,
  findAdminsByIds,
  findAdminsByEmails,
};
