/**
 * Retention service (roadmap 2.7; findings gov.03, ops.12, ops2.09, doc.10,
 * gov.11, db.06, ten.14).
 *
 * WHY IT EXISTS
 *   The RETENTION_* settings used to be parsed and never read, so audit,
 *   access and login logs, sessions, exports and soft-deleted rows grew
 *   without bound. This module is the one place those windows are enforced:
 *   the cleanup job (`jobs/cleanup.job.js`) and the operator script
 *   (`npm run db:retention`) both call `runRetention()`.
 *
 * WHAT IT DOES (one policy per collection, see `getPolicies()`)
 *   - Deletes rows older than their window in bounded batches
 *     (RETENTION_BATCH_SIZE rows per delete, RETENTION_MAX_BATCHES_PER_RUN
 *     batches per policy per run; whatever is left is picked up next run).
 *   - Expires export and report artefacts: deletes the stored object, keeps
 *     the row (downloads answer 410 EXPORT_EXPIRED), deletes the row later.
 *   - Hard-deletes soft-deleted rows after RETENTION_SOFT_DELETE_DAYS, and
 *     anonymises then deletes soft-deleted users after
 *     RETENTION_DELETED_USER_DAYS (`anonymise.service.js#anonymiseUser`).
 *   - Purges every tenant-owned collection of an archived tenant after
 *     RETENTION_ARCHIVED_TENANT_DAYS (0 = never; the default).
 *   - Applies policies other packages declare in
 *     `src/constants/retention.<package>.js` (retention coverage contract).
 *
 * SAFETY
 *   - Dry run (`dryRun: true`, or RETENTION_DRY_RUN=true for the scheduled
 *     job) only counts what would be deleted.
 *   - Legal hold: tenants listed in RETENTION_LEGAL_HOLD_TENANT_IDS or with
 *     `legalHold: true` on their Tenant row, and any row carrying
 *     `legalHold: true`, are never deleted.
 *   - The audit trail is only ever truncated from its oldest end, never in
 *     the middle (it is append-only and may be hash-chained): a legal hold
 *     on a tenant holds back every audit row from that tenant's oldest one.
 *   - A window of 0 (or less) disables that policy.
 *   - Deletes go through the driver collection (no Mongoose middleware), so
 *     soft-delete / tenant-scope filters and per-row audit copies do not
 *     interfere; each run is recorded once (JobRun + one audit event).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import logger from '../utils/logger.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import * as storageService from './storage.service.js';
import { expireArtifacts as expireExportArtifacts } from './auditExport.service.js';
import { anonymiseUser } from './anonymise.service.js';
import { AuditLog } from '../models/AuditLog.js';
import { AccessLog } from '../models/AccessLog.js';
import { LoginAttempt } from '../models/LoginAttempt.js';
import { Session } from '../models/Session.js';
import { PasswordResetToken } from '../models/PasswordResetToken.js';
import { EmailVerificationToken } from '../models/EmailVerificationToken.js';
import { TenantInvitation } from '../models/TenantInvitation.js';
import { Notification } from '../models/Notification.js';
import { AlertEvent } from '../models/AlertEvent.js';
import { AnalyticsQuery } from '../models/AnalyticsQuery.js';
import { JobRun } from '../models/JobRun.js';
import { SyncRun, SYNC_RUN_OPEN_STATUSES } from '../models/SyncRun.js';
import { OutboundEmail, OUTBOX_TERMINAL_STATUSES } from '../models/OutboundEmail.js';
import { AuditExport } from '../models/AuditExport.js';
import { Report } from '../models/Report.js';
import { User } from '../models/User.js';
import { UserRole } from '../models/UserRole.js';
import { Tenant } from '../models/Tenant.js';
import { Connector } from '../models/Connector.js';
import { ConnectorRow } from '../models/ConnectorRow.js';
import { Dashboard } from '../models/Dashboard.js';
import { Widget } from '../models/Widget.js';
import { AlertRule } from '../models/AlertRule.js';
import { ApiKey } from '../models/ApiKey.js';
import { EmbedToken } from '../models/EmbedToken.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONSTANTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../constants');
const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models');
const DECLARED_FILE = /^retention\.([A-Za-z0-9_-]+)\.js$/;
const ENV_KEY = /^RETENTION_[A-Z0-9_]+_DAYS$/;
const MODEL_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** Archived tenants purged per run (each can be large). */
const TENANTS_PER_RUN = 5;

/** Soft-deletable tenant data hard-deleted after RETENTION_SOFT_DELETE_DAYS. */
const SOFT_DELETED_MODELS = Object.freeze([
  Connector, ConnectorRow, Dashboard, Widget, Report, AlertRule, AlertEvent,
  Notification, AnalyticsQuery, ApiKey, EmbedToken,
]);

/**
 * Collections an archived-tenant purge leaves alone: the tenant tombstone,
 * the append-only audit trail (it ages out by its own window, from the
 * oldest end), billing and payment records (statutory retention), and
 * data-subject request evidence.
 */
export const TENANT_PURGE_EXCLUDED = Object.freeze(new Set([
  'Tenant', 'AuditLog', 'ComplianceLog',
  'PaymentTransaction', 'Subscription', 'SubscriptionHistory', 'WebhookEvent',
  'JobRun', 'JobLock',
]));

/** Storage prefixes holding a tenant's artefacts (service-level keys). */
export function tenantStoragePrefixes(tenantId) {
  const id = String(tenantId);
  return [`reports/${id}/`, `audit/exports/${id}/`, `access-logs/exports/${id}/`, `exports/${id}/`, `tenant-exports/${id}/`]; // backups: tenant data export archives
}

/* ------------------------------- helpers -------------------------------- */

/** Cutoff `days` before `now`, or null when the policy is disabled. */
export function cutoffFor(days, now) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() - n * DAY_MS);
}

/** Tenant ids in both stored shapes (string and ObjectId). */
function idForms(ids) {
  const out = [];
  for (const id of ids) {
    out.push(String(id));
    if (mongoose.isValidObjectId(id) && String(id).length === 24) out.push(new mongoose.Types.ObjectId(String(id)));
  }
  return out;
}

/** Filter that keeps legal-hold rows and held tenants out of a purge. */
function holdFilter(policy, ctx) {
  const parts = [{ legalHold: { $ne: true } }];
  if (policy.tenantField && ctx.heldTenantIds.length > 0) {
    parts.push({ [policy.tenantField]: { $nin: idForms(ctx.heldTenantIds) } });
  }
  return parts;
}

function and(...filters) {
  const parts = filters.flat().filter((f) => f && Object.keys(f).length > 0);
  return parts.length === 1 ? parts[0] : { $and: parts };
}

/**
 * Delete (or, in a dry run, count) documents matching `filter`, in bounded
 * batches straight on the driver collection.
 *
 * @returns {Promise<{ matched: number, deleted: number, more: boolean }>}
 */
export async function purgeBatched(model, filter, ctx, { sort = null } = {}) {
  const coll = model.collection;
  if (ctx.dryRun) {
    const matched = await coll.countDocuments(filter);
    return { matched, deleted: 0, more: false };
  }
  let deleted = 0;
  let more = false;
  for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
    // `sort` keeps a partial run (batch cap reached) deleting a contiguous
    // prefix, e.g. the audit trail by hash-chain seq, so no gap appears.
    const cursor = coll.find(filter, { projection: { _id: 1 } });
    if (sort) cursor.sort(sort);
    const ids = (await cursor.limit(ctx.batchSize).toArray()).map((d) => d._id);
    if (ids.length === 0) break;
    // Re-apply the filter: a row that changed since it was read stays.
    const result = await coll.deleteMany({ $and: [filter, { _id: { $in: ids } }] });
    deleted += result.deletedCount ?? 0;
    if (ids.length < ctx.batchSize) break;
    if (batch === ctx.maxBatches - 1) {
      more = (await coll.countDocuments(filter, { limit: 1 })) > 0;
    }
  }
  return { matched: deleted, deleted, more };
}

/**
 * Tenants under legal hold: RETENTION_LEGAL_HOLD_TENANT_IDS (or the given
 * list) plus every tenant with `legalHold: true`.
 *
 * @param {string[]} [configured=env.retention.legalHoldTenantIds]
 * @returns {Promise<string[]>}
 */
export async function getLegalHoldTenantIds(configured = env.retention.legalHoldTenantIds) {
  const ids = new Set((configured ?? []).map((v) => String(v).trim()).filter(Boolean));
  const flagged = await Tenant.collection.find({ legalHold: true }, { projection: { _id: 1 } }).toArray();
  for (const t of flagged) ids.add(String(t._id));
  return [...ids];
}

/* --------------------------- custom policies ---------------------------- */

/**
 * Audit trail: truncated from the oldest end only. A held tenant's oldest
 * audit row older than the cutoff becomes the boundary; when rows carry a
 * hash-chain `seq`, nothing at or after the first kept `seq` is removed.
 */
async function purgeAuditLog(ctx, policy, cutoff) {
  const coll = AuditLog.collection;
  let boundary = cutoff;
  if (ctx.heldTenantIds.length > 0) {
    const oldestHeld = await coll
      .find({ tenantId: { $in: idForms(ctx.heldTenantIds) }, occurredAt: { $lt: cutoff } }, { projection: { occurredAt: 1 } })
      .sort({ occurredAt: 1 })
      .limit(1)
      .next();
    if (oldestHeld?.occurredAt) boundary = new Date(oldestHeld.occurredAt);
  }
  const filter = { occurredAt: { $lt: boundary } };
  if (AuditLog.schema.path('seq')) {
    const firstKept = await coll
      .find({ occurredAt: { $gte: boundary }, seq: { $type: 'number' } }, { projection: { seq: 1 } })
      .sort({ seq: 1 })
      .limit(1)
      .next();
    if (firstKept) filter.$or = [{ seq: { $lt: firstKept.seq } }, { seq: null }];
  }
  const sort = AuditLog.schema.path('seq') ? { seq: 1, occurredAt: 1 } : { occurredAt: 1 };
  const result = await purgeBatched(AuditLog, filter, ctx, { sort });
  return { ...result, heldBack: boundary.getTime() !== cutoff.getTime() };
}

/**
 * Analytics export files (AnalyticsQuery kind 'export') past the export
 * download window: delete the stored object, keep the record with
 * `artifact.expiredAt` so downloads answer 410 EXPORT_EXPIRED.
 */
async function expireAnalyticsExports(ctx, policy, cutoff) {
  const coll = AnalyticsQuery.collection;
  const filter = and(
    { kind: 'export', 'artifact.resultKey': { $type: 'string' }, 'artifact.finishedAt': { $lt: cutoff } },
    holdFilter(policy, ctx),
  );
  if (ctx.dryRun) {
    const matched = await coll.countDocuments(filter);
    return { matched, deleted: 0, more: false };
  }
  const out = { matched: 0, deleted: 0, objectsDeleted: 0, failed: 0, more: false };
  for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
    const docs = await coll.find(filter, { projection: { _id: 1, 'artifact.resultKey': 1 } }).limit(ctx.batchSize).toArray();
    if (docs.length === 0) break;
    let batchFailed = 0;
    for (const doc of docs) {
      out.matched += 1;
      try {
        await storageService.del(doc.artifact.resultKey);
        out.objectsDeleted += 1;
      } catch {
        out.failed += 1;
        batchFailed += 1;
        continue;
      }
      await coll.updateOne(
        { _id: doc._id, 'artifact.resultKey': doc.artifact.resultKey },
        { $set: { 'artifact.resultKey': null, 'artifact.expiredAt': ctx.now } },
      );
      out.deleted += 1;
    }
    if (docs.length < ctx.batchSize || batchFailed > 0) break;
  }
  return out;
}

/** Audit / access-log export artefacts past their download window. */
async function expireExports(ctx) {
  const r = await expireExportArtifacts({
    now: ctx.now,
    dryRun: ctx.dryRun,
    batchSize: ctx.batchSize,
    maxBatches: ctx.maxBatches,
    excludeTenantIds: ctx.heldTenantIds,
  });
  return { matched: r.matched, deleted: r.expired, objectsDeleted: r.objectsDeleted, failed: r.failed };
}

/**
 * Report artefacts older than the window: delete the stored object, clear
 * the run's `resultKey` and stamp `expiredAt` (downloads answer 410).
 */
async function expireReportArtifacts(ctx, policy, cutoff) {
  const coll = Report.collection;
  const runExpired = (run) => typeof run?.resultKey === 'string' && run.resultKey
    && run.finishedAt && new Date(run.finishedAt).getTime() < cutoff.getTime();
  const filter = and(
    { runs: { $elemMatch: { resultKey: { $type: 'string' }, finishedAt: { $lt: cutoff } } } },
    holdFilter(policy, ctx),
  );
  const out = { matched: 0, deleted: 0, objectsDeleted: 0, failed: 0, more: false };
  for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
    const docs = await coll
      .find(filter, { projection: { _id: 1, tenantId: 1, runs: 1, lastRun: 1 } })
      .limit(ctx.batchSize)
      .toArray();
    if (docs.length === 0) break;
    let batchFailed = 0;
    for (const doc of docs) {
      const expired = (doc.runs ?? []).filter(runExpired);
      out.matched += expired.length;
      if (ctx.dryRun) continue;
      const done = [];
      for (const run of expired) {
        try {
          await storageService.del(run.resultKey);
          out.objectsDeleted += 1;
          done.push(run);
        } catch {
          out.failed += 1;
          batchFailed += 1;
        }
      }
      if (done.length === 0) continue;
      const $set = { 'runs.$[r].resultKey': null, 'runs.$[r].expiredAt': ctx.now };
      const keys = new Set(done.map((r) => r.resultKey));
      if (doc.lastRun?.resultKey && keys.has(doc.lastRun.resultKey)) {
        $set['lastRun.resultKey'] = null;
        $set['lastRun.expiredAt'] = ctx.now;
      }
      await coll.updateOne({ _id: doc._id }, { $set }, { arrayFilters: [{ 'r._id': { $in: done.map((r) => r._id) } }] });
      out.deleted += done.length;
    }
    if (ctx.dryRun || docs.length < ctx.batchSize || batchFailed > 0) break;
  }
  return out;
}

/** Stored artefacts of one report (before the report row is hard-deleted). */
async function deleteReportStorage(doc) {
  const keys = new Set();
  for (const run of doc.runs ?? []) if (run?.resultKey) keys.add(run.resultKey);
  if (doc.lastRun?.resultKey) keys.add(doc.lastRun.resultKey);
  const r = await storageService.delMany([...keys]);
  if (r.failed.length > 0) {
    const err = new Error('Could not delete every stored report artefact');
    err.code = 'STORAGE_DELETE_FAILED';
    throw err;
  }
  return r.deleted;
}

/** Soft-deleted tenant data past RETENTION_SOFT_DELETE_DAYS. */
async function purgeSoftDeleted(ctx, policy, cutoff) {
  const out = { matched: 0, deleted: 0, objectsDeleted: 0, failed: 0, more: false, details: {} };
  for (const model of SOFT_DELETED_MODELS) {
    const scoped = { ...policy, tenantField: model.schema.path('tenantId') ? 'tenantId' : null };
    const filter = and({ deletedAt: { $ne: null, $lt: cutoff } }, holdFilter(scoped, ctx));
    let r;
    if (model === Report && !ctx.dryRun) {
      r = { matched: 0, deleted: 0, more: false };
      for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
        const docs = await model.collection
          .find(filter, { projection: { _id: 1, runs: 1, lastRun: 1 } })
          .limit(ctx.batchSize)
          .toArray();
        if (docs.length === 0) break;
        let batchFailed = 0;
        for (const doc of docs) {
          r.matched += 1;
          try {
            out.objectsDeleted += await deleteReportStorage(doc);
            const del = await model.collection.deleteOne({ _id: doc._id, deletedAt: { $ne: null } });
            r.deleted += del.deletedCount ?? 0;
          } catch {
            out.failed += 1;
            batchFailed += 1;
          }
        }
        if (docs.length < ctx.batchSize || batchFailed > 0) break;
      }
    } else {
      r = await purgeBatched(model, filter, ctx);
    }
    out.details[model.modelName] = ctx.dryRun ? r.matched : r.deleted;
    out.matched += r.matched;
    out.deleted += r.deleted;
    out.more = out.more || Boolean(r.more);
  }
  return out;
}

/**
 * Soft-deleted users past RETENTION_DELETED_USER_DAYS: personal data is
 * anonymised (`anonymiseUser`), then the user row and its role grants are
 * deleted.
 */
async function purgeDeletedUsers(ctx, policy, cutoff) {
  const coll = User.collection;
  const filter = and({ deletedAt: { $ne: null, $lt: cutoff } }, holdFilter(policy, ctx));
  if (ctx.dryRun) return { matched: await coll.countDocuments(filter), deleted: 0, failed: 0 };
  const out = { matched: 0, deleted: 0, anonymised: 0, failed: 0, more: false };
  for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
    const users = await coll.find(filter, { projection: { _id: 1, tenantId: 1 } }).limit(ctx.batchSize).toArray();
    if (users.length === 0) break;
    let batchFailed = 0;
    for (const user of users) {
      out.matched += 1;
      try {
        await anonymiseUser({ tenantId: String(user.tenantId), userId: String(user._id), by: 'system:retention' });
        out.anonymised += 1;
        await UserRole.collection.deleteMany({ tenantId: String(user.tenantId), userId: String(user._id) });
        const del = await coll.deleteOne({ _id: user._id, deletedAt: { $ne: null } });
        out.deleted += del.deletedCount ?? 0;
      } catch (err) {
        out.failed += 1;
        batchFailed += 1;
        logger.warn({ err: sanitizeError(err), userId: String(user._id) }, 'retention: could not purge deleted user');
      }
    }
    if (users.length < ctx.batchSize || batchFailed > 0) break;
  }
  return out;
}

let allModelsLoaded = null;

/**
 * Import every model file once, so a tenant purge also reaches collections
 * this process never touched (a model is only known once imported).
 */
function loadAllModels() {
  if (!allModelsLoaded) {
    allModelsLoaded = (async () => {
      let files = [];
      try {
        files = (await fs.readdir(MODELS_DIR)).filter((f) => /^[A-Z][A-Za-z0-9]*\.js$/.test(f));
      } catch {
        return;
      }
      for (const file of files) {
        try {
          await import(pathToFileURL(path.join(MODELS_DIR, file)).href);
        } catch (err) {
          logger.warn({ err: sanitizeError(err), file }, 'retention: could not load model');
        }
      }
    })();
  }
  return allModelsLoaded;
}

/**
 * Delete (or count) every tenant-owned row and stored artefact of one
 * tenant. Reused by the archived-tenant policy; exported for a future
 * tenant-deletion flow.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Object} params.ctx - `{ dryRun, batchSize, maxBatches }`.
 * @returns {Promise<{ matched: number, deleted: number, objectsDeleted: number, complete: boolean, details: Object }>}
 */
export async function purgeTenantData({ tenantId, ctx }) {
  await loadAllModels();
  const ids = idForms([tenantId]);
  const out = { matched: 0, deleted: 0, objectsDeleted: 0, complete: true, details: {} };
  for (const name of mongoose.modelNames().sort()) {
    if (TENANT_PURGE_EXCLUDED.has(name)) continue;
    const model = mongoose.model(name);
    if (!model.schema.path('tenantId')) continue;
    const r = await purgeBatched(model, { tenantId: { $in: ids } }, ctx);
    if (r.matched > 0) out.details[name] = ctx.dryRun ? r.matched : r.deleted;
    out.matched += r.matched;
    out.deleted += r.deleted;
    if (r.more) out.complete = false;
  }
  for (const prefix of tenantStoragePrefixes(tenantId)) {
    for (let batch = 0; batch < ctx.maxBatches; batch += 1) {
      const r = await storageService.delPrefix(prefix, { limit: ctx.batchSize, dryRun: ctx.dryRun });
      out.objectsDeleted += ctx.dryRun ? r.matched : r.deleted;
      if (r.failed > 0) out.complete = false;
      if (ctx.dryRun || r.matched < ctx.batchSize || r.failed > 0) break;
      if (batch === ctx.maxBatches - 1) out.complete = false;
    }
  }
  return out;
}

/** Archived tenants past RETENTION_ARCHIVED_TENANT_DAYS. */
async function purgeArchivedTenants(ctx, policy, cutoff) {
  const heldIds = idForms(ctx.heldTenantIds).filter((v) => typeof v !== 'string');
  const tenants = await Tenant.collection
    .find(
      {
        status: 'archived',
        archivedAt: { $ne: null, $lt: cutoff },
        dataPurgedAt: null,
        legalHold: { $ne: true },
        ...(heldIds.length > 0 ? { _id: { $nin: heldIds } } : {}),
      },
      { projection: { _id: 1 } },
    )
    .limit(TENANTS_PER_RUN)
    .toArray();
  const out = { matched: 0, deleted: 0, objectsDeleted: 0, tenants: 0, tenantsCompleted: 0, more: false, details: {} };
  for (const tenant of tenants) {
    const tenantId = String(tenant._id);
    const r = await purgeTenantData({ tenantId, ctx });
    out.tenants += 1;
    out.matched += r.matched;
    out.deleted += r.deleted;
    out.objectsDeleted += r.objectsDeleted;
    out.details[tenantId] = r.details;
    if (!ctx.dryRun && r.complete) {
      await Tenant.collection.updateOne({ _id: tenant._id }, { $set: { dataPurgedAt: ctx.now } });
      out.tenantsCompleted += 1;
    }
    if (!r.complete) out.more = true;
  }
  if (tenants.length === TENANTS_PER_RUN) out.more = true;
  return out;
}

/* ------------------------------- policies ------------------------------- */

/**
 * Built-in policies, in execution order. `days(settings)` reads the window;
 * `filter(cutoff)` selects expired rows for the generic batched delete, or
 * `run(ctx, policy, cutoff)` implements a custom policy.
 */
const BUILTIN_POLICIES = Object.freeze([
  {
    key: 'auditLogs', collection: 'AuditLog', model: AuditLog, envKey: 'RETENTION_AUDIT_LOG_DAYS',
    days: (s) => s.auditLogDays, field: 'occurredAt', tenantField: 'tenantId', run: purgeAuditLog,
    description: 'Audit trail, including security events (oldest rows first; never in the middle).',
  },
  {
    key: 'accessLogs', collection: 'AccessLog', model: AccessLog, envKey: 'RETENTION_ACCESS_LOG_DAYS',
    days: (s) => s.accessLogDays, field: 'occurredAt', tenantField: 'tenantId',
    filter: (c) => ({ occurredAt: { $lt: c } }), description: 'HTTP access trace.',
  },
  {
    key: 'loginAttempts', collection: 'LoginAttempt', model: LoginAttempt, envKey: 'RETENTION_LOGIN_ATTEMPT_DAYS',
    days: (s) => s.loginAttemptDays, field: 'occurredAt', tenantField: 'tenantId',
    filter: (c) => ({ occurredAt: { $lt: c } }), description: 'Login attempts (lockout evidence).',
  },
  {
    key: 'sessions', collection: 'Session', model: Session, envKey: 'RETENTION_SESSION_DAYS',
    days: (s) => s.sessionDays, field: 'updatedAt', tenantField: 'tenantId',
    filter: (c) => ({ $or: [{ status: { $ne: 'active' }, updatedAt: { $lt: c } }, { expiresAt: { $lt: c } }] }),
    description: 'Revoked or expired sessions (live expiry is also a TTL index).',
  },
  {
    key: 'passwordResetTokens', collection: 'PasswordResetToken', model: PasswordResetToken, envKey: 'RETENTION_EXPIRED_TOKEN_DAYS',
    days: (s) => s.expiredTokenDays, field: 'expiresAt', tenantField: 'tenantId',
    filter: (c) => ({ $or: [{ expiresAt: { $lt: c } }, { usedAt: { $ne: null, $lt: c } }] }),
    description: 'Used or expired password-reset tokens (TTL backstop).',
  },
  {
    key: 'emailVerificationTokens', collection: 'EmailVerificationToken', model: EmailVerificationToken, envKey: 'RETENTION_EXPIRED_TOKEN_DAYS',
    days: (s) => s.expiredTokenDays, field: 'expiresAt', tenantField: 'tenantId',
    filter: (c) => ({ $or: [{ expiresAt: { $lt: c } }, { usedAt: { $ne: null, $lt: c } }] }),
    description: 'Used or expired email-verification tokens (TTL backstop).',
  },
  {
    key: 'tenantInvitations', collection: 'TenantInvitation', model: TenantInvitation, envKey: 'RETENTION_EXPIRED_TOKEN_DAYS',
    days: (s) => s.expiredTokenDays, field: 'expiresAt', tenantField: 'tenantId',
    filter: (c) => ({ $or: [{ expiresAt: { $lt: c } }, { status: { $ne: 'pending' }, updatedAt: { $lt: c } }] }),
    description: 'Accepted, revoked or expired invitations (TTL backstop).',
  },
  {
    key: 'notifications', collection: 'Notification', model: Notification, envKey: 'RETENTION_NOTIFICATION_DAYS',
    days: (s) => s.notificationDays, field: 'createdAt', tenantField: 'tenantId',
    filter: (c) => ({ createdAt: { $lt: c } }), description: 'In-app notifications.',
  },
  {
    key: 'alertEvents', collection: 'AlertEvent', model: AlertEvent, envKey: 'RETENTION_ALERT_EVENT_DAYS',
    days: (s) => s.alertEventDays, field: 'triggeredAt', tenantField: 'tenantId',
    filter: (c) => ({ triggeredAt: { $lt: c } }), description: 'Alert trigger history.',
  },
  {
    key: 'analyticsQueries', collection: 'AnalyticsQuery', model: AnalyticsQuery, envKey: 'RETENTION_ANALYTICS_QUERY_DAYS',
    days: (s) => s.analyticsQueryDays, field: 'createdAt', tenantField: 'tenantId',
    // A record that still owns a stored export file is kept until the
    // analyticsExports policy has removed the file (no orphaned objects).
    filter: (c) => ({ createdAt: { $lt: c }, 'artifact.resultKey': { $in: [null, undefined] } }),
    description: 'Analytics query run records (export records only once their file is gone).',
  },
  {
    key: 'jobRuns', collection: 'JobRun', model: JobRun, envKey: 'RETENTION_JOB_RUN_DAYS',
    days: (s) => s.jobRunDays, field: 'finishedAt', tenantField: null,
    filter: (c) => ({ status: { $ne: 'running' }, finishedAt: { $ne: null, $lt: c } }),
    description: 'Scheduled-job runs (TTL backstop).',
  },
  {
    key: 'syncRuns', collection: 'SyncRun', model: SyncRun, envKey: 'RETENTION_SYNC_RUN_DAYS',
    days: (s) => s.syncRunDays, field: 'finishedAt', tenantField: 'tenantId',
    filter: (c) => ({ status: { $nin: [...SYNC_RUN_OPEN_STATUSES] }, finishedAt: { $ne: null, $lt: c } }),
    description: 'Connector sync runs (TTL backstop).',
  },
  {
    key: 'outboundEmails', collection: 'OutboundEmail', model: OutboundEmail, envKey: 'RETENTION_OUTBOX_DAYS',
    days: (s) => s.outboxDays, field: 'updatedAt', tenantField: 'tenantId',
    filter: (c) => ({ status: { $in: [...OUTBOX_TERMINAL_STATUSES] }, updatedAt: { $lt: c } }),
    description: 'Sent and dead-lettered outbox emails.',
  },
  {
    key: 'exportArtifacts', collection: 'AuditExport', model: AuditExport, envKey: 'RETENTION_EXPORT_DAYS',
    days: (s) => s.exportDays, field: 'expiresAt', tenantField: 'tenantId', run: expireExports, perRowExpiry: true,
    description: 'Audit and access-log export files past their download window (expiresAt).',
  },
  {
    key: 'exportRecords', collection: 'AuditExport', model: AuditExport, envKey: 'RETENTION_EXPORT_RECORD_DAYS',
    days: (s) => s.exportRecordDays, field: 'createdAt', tenantField: 'tenantId',
    // Never a row whose artefact is still stored.
    filter: (c) => ({ createdAt: { $lt: c }, $or: [{ status: { $ne: 'completed' } }, { storageKey: null }] }),
    description: 'Export request records whose file is gone.',
  },
  {
    key: 'analyticsExports', collection: 'AnalyticsQuery', model: AnalyticsQuery, envKey: 'RETENTION_EXPORT_DAYS',
    days: (s) => s.exportDays, field: 'artifact.finishedAt', tenantField: 'tenantId', run: expireAnalyticsExports,
    description: 'Analytics export files past the export download window.',
  },
  {
    key: 'reportArtifacts', collection: 'Report', model: Report, envKey: 'RETENTION_REPORT_ARTIFACT_DAYS',
    days: (s) => s.reportArtifactDays, field: 'runs.finishedAt', tenantField: 'tenantId', run: expireReportArtifacts,
    description: 'Generated report files.',
  },
  {
    key: 'softDeleted', collection: SOFT_DELETED_MODELS.map((m) => m.modelName).join(','), model: null, envKey: 'RETENTION_SOFT_DELETE_DAYS',
    days: (s) => s.softDeleteDays, field: 'deletedAt', tenantField: 'tenantId', run: purgeSoftDeleted,
    description: 'Soft-deleted tenant data (hard delete).',
  },
  {
    key: 'deletedUsers', collection: 'User', model: User, envKey: 'RETENTION_DELETED_USER_DAYS',
    days: (s) => s.deletedUserDays, field: 'deletedAt', tenantField: 'tenantId', run: purgeDeletedUsers,
    description: 'Soft-deleted users (anonymised, then deleted).',
  },
  {
    key: 'archivedTenants', collection: 'Tenant', model: Tenant, envKey: 'RETENTION_ARCHIVED_TENANT_DAYS',
    days: (s) => s.archivedTenantDays, field: 'archivedAt', tenantField: null, run: purgeArchivedTenants,
    description: 'All data of archived tenants (audit trail and billing records excepted).',
  },
]);

/** Policies enforced elsewhere, listed so the retention surface is complete. */
const EXTERNAL_POLICIES = Object.freeze([
  {
    key: 'idempotencyKeys', collection: 'cache', envKey: 'RETENTION_IDEMPOTENCY_DAYS',
    days: (s) => s.idempotencyDays, enforcedBy: 'cache-ttl',
    description: 'Idempotency outcomes expire from the cache (TTL set on write).',
  },
  {
    key: 'usageCounters', collection: 'UsageCounter', envKey: 'USAGE_METERED_RETENTION_DAYS',
    days: () => env.usage?.meteredRetentionDays ?? null, enforcedBy: 'ttl-index',
    description: 'Per-day metered counters expire through their TTL index.',
  },
]);

async function resolveModel(name) {
  if (mongoose.models[name]) return mongoose.models[name];
  const file = path.join(MODELS_DIR, `${name}.js`);
  try {
    await fs.access(file);
    await import(pathToFileURL(file).href);
  } catch {
    return null;
  }
  return mongoose.models[name] ?? null;
}

/**
 * Policies declared by other packages in `src/constants/retention.<key>.js`
 * (`export const RETENTION = [{ model, field, envKey, defaultDays }]`).
 * Invalid entries are reported (skipped), never silently ignored.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir] - directory to scan (tests).
 * @param {Object} [opts.settings] - retention settings (window lookup).
 * @returns {Promise<Array<Object>>}
 */
export async function loadDeclaredPolicies({ dir = CONSTANTS_DIR, settings = env.retention } = {}) {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => DECLARED_FILE.test(f)).sort();
  } catch {
    return [];
  }
  const builtinModels = new Set(BUILTIN_POLICIES.map((p) => p.collection));
  const out = [];
  for (const file of files) {
    const pkg = file.match(DECLARED_FILE)[1];
    let entries;
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      entries = Array.isArray(mod.RETENTION) ? mod.RETENTION : [];
    } catch (err) {
      out.push({ key: `${pkg}:invalid`, source: file, invalid: sanitizeError(err, { fallbackCode: 'RETENTION_DECLARATION_INVALID' }).message });
      continue;
    }
    for (const entry of entries) {
      const model = String(entry?.model ?? '');
      const key = `${pkg}:${model || 'invalid'}`;
      const problems = [];
      if (!MODEL_NAME.test(model)) problems.push('model');
      if (!FIELD_NAME.test(String(entry?.field ?? ''))) problems.push('field');
      if (!ENV_KEY.test(String(entry?.envKey ?? ''))) problems.push('envKey');
      if (!Number.isInteger(entry?.defaultDays) || entry.defaultDays < 0) problems.push('defaultDays');
      if (problems.length > 0) {
        out.push({ key, source: file, invalid: `invalid ${problems.join(', ')}` });
        continue;
      }
      if (builtinModels.has(model)) {
        out.push({ key, source: file, invalid: 'collection already has a built-in policy' });
        continue;
      }
      const configured = settings.byEnvKey?.[entry.envKey];
      out.push({
        key,
        source: file,
        collection: model,
        envKey: entry.envKey,
        configuredDays: Number.isFinite(configured) ? configured : entry.defaultDays,
        days: () => (Number.isFinite(configured) ? configured : entry.defaultDays),
        field: entry.field,
        filter: (c) => ({ [entry.field]: { $lt: c } }),
        declared: true,
        description: entry.description ? String(entry.description).slice(0, 200) : `Declared by ${file}.`,
      });
    }
  }
  return out;
}

/**
 * Every retention policy with its effective window (monitoring surface).
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {Object} [opts.settings] - overrides of env.retention.
 * @returns {Promise<Array<Object>>}
 */
export async function getPolicies({ now = clock.now(), settings = {} } = {}) {
  const s = { ...env.retention, ...settings };
  const declared = await loadDeclaredPolicies({ settings: s });
  const view = (p, enforcedBy) => {
    const days = p.days ? p.days(s) : null;
    const enabled = Number.isFinite(Number(days)) && Number(days) > 0;
    return {
      key: p.key,
      collection: p.collection ?? null,
      envKey: p.envKey ?? null,
      days: Number.isFinite(Number(days)) ? Number(days) : null,
      enabled: Boolean(enabled && !p.invalid),
      cutoff: enabled && !p.perRowExpiry ? cutoffFor(days, now)?.toISOString() ?? null : null,
      field: p.field ?? null,
      enforcedBy,
      description: p.description ?? null,
      ...(p.source ? { source: p.source } : {}),
      ...(p.invalid ? { invalid: p.invalid } : {}),
    };
  };
  return [
    ...BUILTIN_POLICIES.map((p) => view(p, 'cleanup-job')),
    ...declared.map((p) => view(p, 'cleanup-job')),
    ...EXTERNAL_POLICIES.map((p) => view(p, p.enforcedBy)),
  ];
}

/* --------------------------------- run ---------------------------------- */

/**
 * Run every retention policy once.
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now] - the clock (tests pin it).
 * @param {boolean} [opts.dryRun=RETENTION_DRY_RUN] - only count.
 * @param {Object} [opts.settings] - overrides of env.retention (windows,
 *   batchSize, maxBatchesPerRun, legalHoldTenantIds).
 * @param {string[]} [opts.only] - run only these policy keys.
 * @param {string} [opts.declaredDir] - where declared policies live (tests).
 * @returns {Promise<{ dryRun: boolean, startedAt: string, finishedAt: string, legalHoldTenantIds: string[], policies: Array<Object>, totals: Object }>}
 */
export async function runRetention({
  now = clock.now(),
  dryRun = env.retention.dryRun,
  settings = {},
  only = null,
  declaredDir,
} = {}) {
  const s = { ...env.retention, ...settings };
  const startedAt = new Date();
  const ctx = {
    now,
    dryRun: Boolean(dryRun),
    batchSize: Math.max(1, Math.floor(Number(s.batchSize)) || 500),
    maxBatches: Math.max(1, Math.floor(Number(s.maxBatchesPerRun)) || 200),
    heldTenantIds: await getLegalHoldTenantIds(s.legalHoldTenantIds),
  };
  const declared = await loadDeclaredPolicies({ settings: s, ...(declaredDir ? { dir: declaredDir } : {}) });
  const wanted = only ? new Set(only) : null;
  const results = [];

  for (const policy of [...BUILTIN_POLICIES, ...declared]) {
    if (wanted && !wanted.has(policy.key)) continue;
    const base = { key: policy.key, collection: policy.collection ?? null };
    if (policy.invalid) {
      results.push({ ...base, skipped: 'invalid', reason: policy.invalid });
      continue;
    }
    const days = policy.days(s);
    const cutoff = cutoffFor(days, now);
    if (!cutoff && !policy.perRowExpiry) {
      results.push({ ...base, days: Number(days) || 0, skipped: 'disabled' });
      continue;
    }
    try {
      let r;
      if (policy.run) {
        r = await policy.run(ctx, policy, cutoff);
      } else {
        const model = policy.model ?? await resolveModel(policy.collection);
        if (!model) {
          results.push({ ...base, skipped: 'model_not_registered' });
          continue;
        }
        const scoped = { ...policy, tenantField: model.schema.path('tenantId') ? 'tenantId' : null };
        r = await purgeBatched(model, and(policy.filter(cutoff), holdFilter(scoped, ctx)), ctx);
      }
      results.push({
        ...base,
        days: Number(days) || 0,
        cutoff: cutoff ? cutoff.toISOString() : null,
        matched: r.matched ?? 0,
        deleted: r.deleted ?? 0,
        objectsDeleted: r.objectsDeleted ?? 0,
        failed: r.failed ?? 0,
        more: Boolean(r.more),
        ...(r.heldBack ? { heldBack: true } : {}),
        ...(r.anonymised !== undefined ? { anonymised: r.anonymised } : {}),
        ...(r.tenants !== undefined ? { tenants: r.tenants, tenantsCompleted: r.tenantsCompleted ?? 0 } : {}),
        ...(r.details && Object.keys(r.details).length > 0 ? { details: r.details } : {}),
      });
    } catch (err) {
      const error = sanitizeError(err, { fallbackCode: 'RETENTION_POLICY_FAILED' });
      logger.error({ policy: policy.key, err: error }, 'retention policy failed');
      results.push({ ...base, error });
    }
  }

  const totals = { matched: 0, deleted: 0, objectsDeleted: 0, failed: 0, errors: 0 };
  for (const r of results) {
    totals.matched += r.matched ?? 0;
    totals.deleted += r.deleted ?? 0;
    totals.objectsDeleted += r.objectsDeleted ?? 0;
    totals.failed += r.failed ?? 0;
    if (r.error) totals.errors += 1;
  }

  return {
    dryRun: ctx.dryRun,
    now: now.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    legalHoldTenantIds: ctx.heldTenantIds,
    policies: results,
    totals,
  };
}

/**
 * Flatten a run report into the numeric counts stored on the JobRun: one
 * entry per policy that ran (rows deleted, or matched in a dry run) plus
 * the totals.
 *
 * @param {Object} report - from `runRetention`.
 * @returns {Object<string, number>}
 */
export function toJobCounts(report) {
  const counts = {
    dryRun: report.dryRun ? 1 : 0,
    matched: report.totals.matched,
    deleted: report.totals.deleted,
    objectsDeleted: report.totals.objectsDeleted,
    failed: report.totals.failed,
    errors: report.totals.errors,
  };
  for (const r of report.policies) {
    if (r.skipped || r.error) continue;
    counts[r.key] = report.dryRun ? r.matched : r.deleted;
  }
  return counts;
}

export default {
  runRetention,
  getPolicies,
  getLegalHoldTenantIds,
  loadDeclaredPolicies,
  purgeTenantData,
  purgeBatched,
  toJobCounts,
  cutoffFor,
  tenantStoragePrefixes,
  TENANT_PURGE_EXCLUDED,
};
