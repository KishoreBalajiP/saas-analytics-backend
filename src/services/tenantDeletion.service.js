/**
 * Tenant Deletion Service (roadmap 2.10; finding ten.14).
 *
 * PURPOSE
 *   Close a workspace for good, with a grace period and a verified purge:
 *
 *   - requestDeletion   an Owner asks for deletion: typed workspace slug +
 *                       password re-entry. The workspace is closed at once
 *                       (`disabled`, every session revoked) and a
 *                       `TenantDeletion` record schedules the purge after
 *                       `TENANT_DELETION_GRACE_DAYS`. Owners are emailed.
 *   - cancelDeletion    a platform admin cancels a scheduled deletion during
 *                       the grace period; the workspace reopens.
 *   - getDeletion / listDeletions   platform admin visibility
 *   - scheduleArchivedTenants  (opt-in) archived workspaces past
 *                       `TENANT_ARCHIVED_RETENTION_DAYS` are scheduled too
 *   - purgeTenant       deletes every record of the tenant listed in
 *                       `tenantPurge.registry.js` plus its stored files,
 *                       then counts again and returns the verification
 *                       report (every purged collection must count 0)
 *   - runDuePurges      the purge job: claims due records atomically (with a
 *                       lease) and records the outcome
 *
 * SAFETY
 *   - A workspace that is `active` or `pending` is never purged, whatever
 *     the record says (a purge refuses with TENANT_ACTIVE and is retried
 *     until the attempt limit, then stays `failed` for an operator).
 *   - Every purge filter is checked to be tenant-scoped (no null values),
 *     so a malformed id can never widen a delete to other tenants' rows.
 *   - The purge works on raw collections, so soft-deleted rows are purged
 *     and counted too.
 *   - The TenantDeletion record is platform evidence and survives the purge.
 */

import mongoose from 'mongoose';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { ERROR_CODES } from '../config/constants.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import tenantRepository from '../repositories/tenant.repository.js';
import tenantDeletionRepository from '../repositories/tenantDeletion.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import userRepository from '../repositories/user.repository.js';
import membershipRepository from '../repositories/membership.repository.js';
import actorStatus from '../modules/iam/auth/actorStatus.service.js';
import * as storageService from './storage.service.js';
import analyticsCache from './analytics.cache.js';
import emailService from './email.service.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';
import { holdsOwner, verifyStepUp, findOwnerRole } from './tenantOwnership.service.js';
import { PURGE_REGISTRY, STORAGE_PREFIXES } from './tenantPurge.registry.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Tenant } from '../models/Tenant.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_BATCH = 500;
/** Backoff before a failed purge is retried: 15 minutes per attempt so far. */
const RETRY_STEP_MS = 15 * 60 * 1000;

const retryAfterFor = (record, now) => new Date(now.getTime() + RETRY_STEP_MS * Math.max(1, record.attempts ?? 1));

function typed(status, message, code, errors) {
  return new ApiError(status, message, { code, errors });
}

function settings() {
  const m = env.members ?? {};
  return {
    graceDays: Math.max(1, Number(m.deletionGraceDays) || 30),
    archivedRetentionDays: Math.max(1, Number(m.archivedRetentionDays) || 30),
    purgeArchivedEnabled: Boolean(m.purgeArchivedEnabled),
    batchSize: Math.max(1, Number(m.purgeBatchSize) || 5),
    maxAttempts: Math.max(1, Number(m.purgeMaxAttempts) || 5),
    leaseMs: Math.max(60000, Number(m.purgeLeaseMs) || 30 * 60 * 1000),
  };
}

/** What the purge keeps (see the registry's `retain` entries). */
export function purgeConfig() {
  return {
    retainAuditLogs: env.members?.purgeRetainAuditLogs !== false,
    retainBillingRecords: env.members?.purgeRetainBillingRecords !== false,
  };
}

/** Public view of a deletion record. */
export function deletionView(record) {
  if (!record) return null;
  return {
    id: String(record._id),
    tenantId: record.tenantId,
    tenantSlug: record.tenantSlug ?? null,
    tenantName: record.tenantName ?? null,
    status: record.status,
    source: record.source,
    requestedBy: record.requestedBy ?? null,
    requestedAt: record.requestedAt ?? null,
    purgeAfter: record.purgeAfter ?? null,
    reason: record.reason ?? null,
    cancelledAt: record.cancelledAt ?? null,
    cancelledBy: record.cancelledBy ?? null,
    cancelReason: record.cancelReason ?? null,
    attempts: record.attempts ?? 0,
    startedAt: record.startedAt ?? null,
    purgedAt: record.purgedAt ?? null,
    lastError: record.lastError?.code ? record.lastError : null,
    verification: record.verification?.checkedAt ? record.verification : null,
    createdAt: record.createdAt ?? null,
  };
}

/** Email every active Owner (best effort; never blocks the request). */
async function notifyOwners({ tenantId, tenant, purgeAfter }) {
  try {
    const ownerRole = await findOwnerRole(tenantId);
    if (!ownerRole) return 0;
    const ids = await membershipRepository.listHolderIds({ tenantId, roleId: String(ownerRole._id) });
    let sent = 0;
    for (const id of ids) {
      const user = await userRepository.findById(id).catch(() => null);
      if (!user || user.status !== 'active' || !user.email) continue;
      await emailService.send({
        to: user.email,
        subject: 'Your Analivo workspace is scheduled for deletion',
        text: `The workspace "${tenant.name}" (${tenant.slug}) was closed and is scheduled for permanent deletion on ${purgeAfter.toISOString().slice(0, 10)}.\n\nAll of its data will be deleted then and cannot be recovered. If you did not request this, contact support before that date to cancel the deletion.`,
      }).then(() => { sent += 1; }).catch((err) => {
        logger.warn({ err: { message: err?.message }, tenantId: String(tenantId) }, 'deletion notice email failed');
      });
    }
    return sent;
  } catch (err) {
    logger.warn({ err: { message: err?.message }, tenantId: String(tenantId) }, 'deletion notice failed');
    return 0;
  }
}

/**
 * An Owner schedules the deletion of their workspace.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId - from the caller's token.
 * @param {string} opts.by - the acting tenant user.
 * @param {string} opts.confirm - must equal the workspace slug.
 * @param {string} opts.password - the actor's password (step-up).
 * @param {string|null} [opts.reason]
 * @param {Date} [opts.now]
 * @returns {Promise<Object>} the deletion view.
 */
export async function requestDeletion({ tenantId, by, confirm, password, reason = null, now = new Date() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (tenant.status !== 'active') throw ApiError.conflict('Only an active workspace can be scheduled for deletion');
  if (!(await holdsOwner({ tenantId, userId: by }))) {
    throw ApiError.forbidden('Only a workspace Owner can delete the workspace');
  }
  if (String(confirm ?? '').trim().toLowerCase() !== String(tenant.slug).toLowerCase()) {
    throw ApiError.validation('Validation failed', [{ field: 'confirm', message: `Type the workspace slug "${tenant.slug}" to confirm` }]);
  }
  await verifyStepUp({ tenantId, userId: by, password });
  if (await tenantDeletionRepository.findOpenByTenant(tenantId)) {
    throw typed(409, 'This workspace is already scheduled for deletion', ERROR_CODES.DELETION_PENDING);
  }

  const { graceDays } = settings();
  const purgeAfter = new Date(now.getTime() + graceDays * DAY_MS);
  let record;
  try {
    record = await tenantDeletionRepository.create({
      tenantId: String(tenantId),
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      source: 'owner_request',
      requestedBy: { type: 'user', id: String(by) },
      requestedAt: now,
      reason: reason ? String(reason).slice(0, 500) : null,
      purgeAfter,
      previousStatus: tenant.status,
    });
  } catch (err) {
    if (err?.code === 11000) throw typed(409, 'This workspace is already scheduled for deletion', ERROR_CODES.DELETION_PENDING);
    throw err;
  }

  const closed = await tenantRepository.disableForDeletion(tenantId, {
    by: String(by),
    reason: `Deletion requested; purge after ${purgeAfter.toISOString()}`,
  });
  if (!closed) {
    await tenantDeletionRepository.cancel(record._id, {
      by: { type: 'system', id: 'tenant-deletion' }, reason: 'Workspace status changed during the request', now,
    });
    throw ApiError.conflict('The workspace status changed; reload and try again');
  }
  const sessionsRevoked = await sessionRepository.revokeAllForTenant(String(tenantId), 'tenant deletion requested');
  actorStatus.invalidate('tenant', String(tenantId));
  await invalidateScope(String(tenantId));

  const actor = { type: 'user', id: String(by) };
  await auditEmit({
    actor,
    action: 'tenant.deletion_requested',
    module: 'iam.tenants',
    resource: { type: 'tenant', id: String(tenantId) },
    tenantId: String(tenantId),
    before: { status: tenant.status },
    after: { status: 'disabled', purgeAfter: purgeAfter.toISOString(), deletionId: String(record._id), sessionsRevoked },
    reason: reason ?? undefined,
  });
  await securityEvent('TENANT_DELETION_REQUESTED', {
    actor,
    tenantId: String(tenantId),
    reason: reason ?? undefined,
    metadata: { deletionId: String(record._id), purgeAfter: purgeAfter.toISOString(), sessionsRevoked },
  });
  await notifyOwners({ tenantId, tenant, purgeAfter });
  return deletionView(record);
}

/**
 * Cancel a scheduled deletion (platform admin, during the grace period).
 * A workspace closed by the request reopens (`disabled` -> `active`).
 */
export async function cancelDeletion({ tenantId, by, reason = null, actorType = 'admin', now = new Date() } = {}) {
  const open = await tenantDeletionRepository.findOpenByTenant(tenantId);
  if (!open) throw ApiError.notFound('This workspace has no pending deletion');
  if (open.status !== 'scheduled') {
    throw ApiError.conflict('The purge has already started; this deletion can no longer be cancelled');
  }
  const cancelled = await tenantDeletionRepository.cancel(open._id, {
    by: { type: actorType === 'admin' ? 'admin' : 'system', id: by ? String(by) : null },
    reason: reason ? String(reason).slice(0, 500) : null,
    now,
  });
  if (!cancelled) throw ApiError.conflict('The purge has already started; this deletion can no longer be cancelled');

  const tenant = await tenantRepository.findById(tenantId);
  let reopened = false;
  if (tenant && open.previousStatus === 'active' && tenant.status === 'disabled') {
    reopened = Boolean(await tenantRepository.restore(tenantId, { by: by ? String(by) : null, reason: 'Deletion cancelled' }));
    actorStatus.invalidate('tenant', String(tenantId));
    await invalidateScope(String(tenantId));
  }
  const actor = { type: actorType === 'admin' ? 'admin' : 'system', id: String(by ?? 'system') };
  await auditEmit({
    actor,
    action: 'tenant.deletion_cancelled',
    module: 'iam.tenants',
    resource: { type: 'tenant', id: String(tenantId) },
    tenantId: String(tenantId),
    before: { deletionStatus: 'scheduled', status: tenant?.status ?? null },
    after: { deletionStatus: 'cancelled', reopened },
    reason: reason ?? undefined,
  });
  await securityEvent('TENANT_DELETION_CANCELLED', {
    actor, tenantId: String(tenantId), reason: reason ?? undefined, metadata: { deletionId: String(open._id), reopened },
  });
  return { ...deletionView(cancelled), reopened };
}

/**
 * What the Owner's danger zone needs: the workspace name and slug (typed to
 * confirm), the grace period, and any open deletion.
 */
export async function getDeletionContext({ tenantId } = {}) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  const open = await tenantDeletionRepository.findOpenByTenant(tenantId);
  return {
    workspace: { id: String(tenant._id), name: tenant.name, slug: tenant.slug, status: tenant.status },
    graceDays: settings().graceDays,
    pending: open ? deletionView(open) : null,
  };
}

/** The tenant's most recent deletion record, or null. */
export async function getDeletion({ tenantId } = {}) {
  return deletionView(await tenantDeletionRepository.findLatestByTenant(tenantId));
}

/** Whether a deletion is scheduled, running or failed for the tenant. */
export async function hasOpenDeletion(tenantId) {
  return Boolean(await tenantDeletionRepository.findOpenByTenant(tenantId));
}

/** Platform admin listing. */
export async function listDeletions({ status, tenantId, page = 1, limit = 20 } = {}) {
  const result = await tenantDeletionRepository.list({ status, tenantId, page, limit });
  return { ...result, docs: result.docs.map(deletionView) };
}

/**
 * Opt-in (`TENANT_PURGE_ARCHIVED_ENABLED`): schedule archived workspaces
 * whose retention elapsed. A deletion an admin cancelled is not re-created.
 */
export async function scheduleArchivedTenants({ now = new Date(), limit = 50 } = {}) {
  const cfg = settings();
  if (!cfg.purgeArchivedEnabled) return { scheduled: 0 };
  const before = new Date(now.getTime() - cfg.archivedRetentionDays * DAY_MS);
  const tenants = await tenantRepository.listArchivedBefore({ before, limit });
  let scheduled = 0;
  for (const tenant of tenants) {
    const tenantId = String(tenant._id);
    const latest = await tenantDeletionRepository.findLatestByTenant(tenantId);
    if (latest && (latest.open || latest.status === 'cancelled')) continue;
    try {
      await tenantDeletionRepository.create({
        tenantId,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        source: 'archive_retention',
        requestedBy: { type: 'system', id: 'tenant-purge' },
        requestedAt: now,
        reason: `Archived on ${new Date(tenant.archivedAt).toISOString().slice(0, 10)}; retention of ${cfg.archivedRetentionDays} days elapsed`,
        purgeAfter: now,
        previousStatus: 'archived',
      });
      scheduled += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  return { scheduled };
}

/** Refuse any filter that is not pinned to concrete values. */
function assertScoped(name, filter) {
  const values = Object.values(filter ?? {});
  if (values.length === 0) throw new Error(`purge filter for ${name} is empty`);
  for (const value of values) {
    if (value === null || value === undefined) throw new Error(`purge filter for ${name} is not tenant-scoped`);
  }
  return filter;
}

async function collectContext(tenantId) {
  if (!tenantId || !mongoose.isValidObjectId(String(tenantId))) {
    throw new ApiError(400, 'Invalid tenant id for purge', { code: ERROR_CODES.BAD_REQUEST });
  }
  const id = String(tenantId);
  const [users, roles] = await Promise.all([
    User.collection.find({ tenantId: id }, { projection: { _id: 1 } }).toArray(),
    Role.collection.find({ tenantId: id }, { projection: { _id: 1 } }).toArray(),
  ]);
  return {
    tenantId: id,
    tenantObjectId: new mongoose.Types.ObjectId(id),
    userIds: users.map((u) => String(u._id)),
    // RolePermission.roleId is a String path (Mongoose casts on write).
    roleIds: roles.map((r) => String(r._id)),
  };
}

/** Storage keys come back with the service prefix; strip it before delete. */
function unprefix(key) {
  const prefix = storageService.default?.KEY_PREFIX ?? 'storage/';
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

async function purgeStorage(tenantId) {
  let deleted = 0;
  for (const toPrefix of STORAGE_PREFIXES) {
    const prefix = toPrefix(tenantId);
    for (let round = 0; round < 1000; round += 1) {
      const keys = await storageService.list(prefix, { limit: STORAGE_BATCH });
      if (keys.length === 0) break;
      for (const key of keys) {
        await storageService.del(unprefix(key));
        deleted += 1;
      }
    }
  }
  return deleted;
}

async function countStorage(tenantId) {
  let remaining = 0;
  for (const toPrefix of STORAGE_PREFIXES) {
    remaining += (await storageService.list(toPrefix(tenantId), { limit: STORAGE_BATCH })).length;
  }
  return remaining;
}

/**
 * Delete every record and stored file of a tenant, then verify.
 *
 * @param {Object} opts
 * @param {Object} opts.deletion - the claimed TenantDeletion record.
 * @param {{ retainAuditLogs: boolean, retainBillingRecords: boolean }} [opts.config]
 * @returns {Promise<Object>} verification report `{ ok, checkedAt, collections, retained, storage }`.
 */
export async function purgeTenant({ deletion, config = purgeConfig() } = {}) {
  const tenantId = String(deletion?.tenantId ?? '');
  const ctx = await collectContext(tenantId);
  const tenant = await Tenant.collection.findOne({ _id: ctx.tenantObjectId });
  if (tenant && ['active', 'pending'].includes(tenant.status)) {
    throw new ApiError(409, 'Refusing to purge a workspace that is active', { code: 'TENANT_ACTIVE' });
  }
  await sessionRepository.revokeAllForTenant(tenantId, 'tenant purge');

  const plan = PURGE_REGISTRY.map((entry) => {
    const keep = entry.mode === 'retain' && entry.when(config);
    const action = entry.mode === 'detach' ? 'detach' : (entry.mode === 'retain' && keep ? 'retain' : 'delete');
    return { entry, action, filter: assertScoped(entry.name, entry.filter(ctx)) };
  });

  const collections = [];
  for (const { entry, action, filter } of plan) {
    if (action === 'retain') continue;
    if (action === 'detach') {
      const res = await entry.model.collection.updateMany(filter, entry.update(ctx));
      collections.push({ name: entry.name, deleted: res.modifiedCount ?? 0, remaining: 0 });
    } else {
      const res = await entry.model.collection.deleteMany(filter);
      collections.push({ name: entry.name, deleted: res.deletedCount ?? 0, remaining: 0 });
    }
  }

  let storageDeleted = 0;
  let storageError = null;
  try {
    storageDeleted = await purgeStorage(tenantId);
  } catch (err) {
    storageError = err;
    logger.warn({ err: { message: err?.message }, tenantId }, 'tenant purge: storage cleanup failed');
  }
  await analyticsCache.invalidateTenant(tenantId).catch(() => 0);
  actorStatus.invalidate('tenant', tenantId);
  for (const userId of ctx.userIds) actorStatus.invalidate('user', userId);
  await invalidateScope(tenantId);

  // Verify: count again, from scratch.
  const retained = [];
  for (const { entry, action, filter } of plan) {
    const remaining = await entry.model.collection.countDocuments(filter);
    if (action === 'retain') {
      retained.push({ name: entry.name, count: remaining, policy: entry.policy ?? null });
    } else {
      collections.find((c) => c.name === entry.name).remaining = remaining;
    }
  }
  let storageRemaining = 0;
  try {
    storageRemaining = await countStorage(tenantId);
  } catch (err) {
    storageError = storageError ?? err;
    storageRemaining = -1;
  }
  const ok = collections.every((c) => c.remaining === 0) && storageRemaining === 0 && !storageError;
  return {
    ok,
    checkedAt: new Date(),
    collections,
    retained,
    storage: { deleted: storageDeleted, remaining: Math.max(0, storageRemaining) },
  };
}

/**
 * The purge job: schedule archived tenants (opt-in), then claim and purge
 * due deletions one at a time, recording each outcome.
 *
 * @returns {Promise<{ scheduled: number, claimed: number, purged: number, failed: number }>}
 */
export async function runDuePurges({ now = new Date(), limit } = {}) {
  const cfg = settings();
  const { scheduled } = await scheduleArchivedTenants({ now });
  const max = limit ?? cfg.batchSize;
  const summary = { scheduled, claimed: 0, purged: 0, failed: 0 };
  for (let i = 0; i < max; i += 1) {
    const claimed = await tenantDeletionRepository.claimDue({ now, leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts });
    if (!claimed) break;
    summary.claimed += 1;
    const actor = { type: 'system', id: 'tenant-purge' };
    try {
      const verification = await purgeTenant({ deletion: claimed });
      if (verification.ok) {
        await tenantDeletionRepository.markPurged(claimed._id, { verification, now: new Date() });
        summary.purged += 1;
        await auditEmit({
          actor,
          action: 'tenant.purged',
          module: 'iam.tenants',
          resource: { type: 'tenant', id: claimed.tenantId },
          tenantId: claimed.tenantId,
          after: {
            deletionId: String(claimed._id),
            slug: claimed.tenantSlug,
            collections: verification.collections.length,
            deleted: verification.collections.reduce((n, c) => n + c.deleted, 0),
            retained: verification.retained.map((r) => `${r.name}:${r.count}`),
          },
        }).catch(() => null);
        await securityEvent('TENANT_PURGED', {
          actor, tenantId: claimed.tenantId, metadata: { deletionId: String(claimed._id), verified: true },
        });
      } else {
        await tenantDeletionRepository.markFailed(claimed._id, {
          error: { code: 'VERIFICATION_FAILED', message: 'Records remained after the purge; it will be retried' },
          verification,
          retryAfter: retryAfterFor(claimed, now),
        });
        summary.failed += 1;
        await securityEvent('TENANT_PURGE_FAILED', {
          actor, tenantId: claimed.tenantId, metadata: { deletionId: String(claimed._id), code: 'VERIFICATION_FAILED' },
        });
      }
    } catch (err) {
      const error = sanitizeError(err, { fallbackCode: 'PURGE_FAILED' });
      await tenantDeletionRepository.markFailed(claimed._id, { error, retryAfter: retryAfterFor(claimed, now) }).catch(() => null);
      summary.failed += 1;
      logger.error({ err: { message: error.message }, tenantId: claimed.tenantId }, 'tenant purge failed');
      await securityEvent('TENANT_PURGE_FAILED', {
        actor, tenantId: claimed.tenantId, metadata: { deletionId: String(claimed._id), code: error.code },
      });
    }
  }
  return summary;
}

export default {
  requestDeletion,
  getDeletionContext,
  cancelDeletion,
  getDeletion,
  hasOpenDeletion,
  listDeletions,
  scheduleArchivedTenants,
  purgeTenant,
  runDuePurges,
  purgeConfig,
  deletionView,
};
