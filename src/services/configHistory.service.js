/**
 * Configuration history + audit helpers (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Shared plumbing for the three platform configuration surfaces
 *   (platform settings, feature flags, email templates):
 *     - typed error codes the frontend branches on;
 *     - recording versioned revisions (`ConfigRevision`) after each change,
 *       with a one-off baseline of the pre-existing state so the very first
 *       change can be rolled back;
 *     - the public (secret-free) view of a revision;
 *     - one audit entry per change through `auditLog.service.emit`.
 *
 * SECURITY RULES
 *   - A revision's `secret` envelope is NEVER returned by `publicRevision`
 *     and never passed to the audit trail; callers redact secret values
 *     before calling `auditChange`.
 *   - Audit failures are logged and swallowed: the change is already
 *     committed and must not be reported as failed.
 */

import ApiError from '../utils/ApiError.js';
import { createChildLogger } from '../utils/logger.js';
import * as revisionRepository from '../repositories/configRevision.repository.js';
import * as auditLogService from './auditLog.service.js';

const logger = createChildLogger({ module: 'services/config_history' });

/** Machine-readable codes for configuration refusals. */
export const CONFIG_ERROR_CODES = Object.freeze({
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  SETTING_NOT_FOUND: 'SETTING_NOT_FOUND',
  SETTING_READ_ONLY: 'SETTING_READ_ONLY',
  SETTING_NOT_SECRET: 'SETTING_NOT_SECRET',
  SECRET_PERMISSION_REQUIRED: 'SECRET_PERMISSION_REQUIRED',
  REVISION_NOT_FOUND: 'REVISION_NOT_FOUND',
  FEATURE_FLAG_NOT_FOUND: 'FEATURE_FLAG_NOT_FOUND',
  FEATURE_FLAG_EXISTS: 'FEATURE_FLAG_EXISTS',
  FEATURE_FLAG_SYSTEM: 'FEATURE_FLAG_SYSTEM',
  FEATURE_FLAG_READ_ONLY: 'FEATURE_FLAG_READ_ONLY',
  EMAIL_TEMPLATE_NOT_FOUND: 'EMAIL_TEMPLATE_NOT_FOUND',
  EMAIL_TEMPLATE_INVALID: 'EMAIL_TEMPLATE_INVALID',
  EMAIL_TEMPLATE_VARIABLES_MISSING: 'EMAIL_TEMPLATE_VARIABLES_MISSING',
  ADMIN_SCOPE_DENIED: 'ADMIN_SCOPE_DENIED',
});

/** 409 raised when the stored version moved on since the caller read it. */
export function versionConflict(currentVersion) {
  return new ApiError(409, 'This configuration was changed by someone else. Reload it and try again.', {
    code: CONFIG_ERROR_CODES.VERSION_CONFLICT,
    errors: [{ field: 'version', message: `the current version is ${currentVersion}` }],
  });
}

/** Typed error helper. */
export function configError(statusCode, code, message, errors) {
  return new ApiError(statusCode, message, { code, errors });
}

/** Normalise a request actor into the `changedBy` / audit actor shape. */
export function actorOf(actor) {
  if (!actor) return { type: 'system', id: null, display: null };
  return {
    type: ['admin', 'user', 'service', 'system'].includes(actor.type) ? actor.type : 'system',
    id: actor.id != null ? String(actor.id) : null,
    display: actor.email ?? actor.display ?? null,
  };
}

/** Public, secret-free view of a revision. */
export function publicRevision(revision) {
  if (!revision) return revision;
  return {
    version: revision.version,
    action: revision.action,
    state: revision.state ?? null,
    isSecret: Boolean(revision.isSecret),
    hasSecretValue: revision.isSecret ? Boolean(revision.secret) : undefined,
    rolledBackFrom: revision.rolledBackFrom ?? null,
    reason: revision.reason ?? null,
    changedBy: { type: revision.changedBy?.type ?? 'system', id: revision.changedBy?.id ?? null },
    createdAt: revision.createdAt ?? null,
  };
}

/**
 * Record the state that existed before the first tracked change, so the
 * first change can be rolled back. A no-op once any revision exists.
 */
export async function ensureBaseline({ kind, resourceKey, version, state, isSecret = false, secret = null }) {
  const latest = await revisionRepository.findLatest({ kind, resourceKey });
  if (latest) return latest;
  try {
    return await revisionRepository.insert({
      kind,
      resourceKey,
      version,
      action: 'baseline',
      state,
      isSecret,
      secret: isSecret ? secret : null,
      changedBy: { type: 'system', id: null },
    });
  } catch (error) {
    if (error?.code === 11000) return revisionRepository.findLatest({ kind, resourceKey });
    throw error;
  }
}

/**
 * Append the revision for a change. A duplicate version means a concurrent
 * writer won; surface it as a version conflict.
 */
export async function recordRevision({
  kind, resourceKey, version, action, state, isSecret = false, secret = null,
  rolledBackFrom = null, reason = null, actor = null,
}) {
  const by = actorOf(actor);
  try {
    return await revisionRepository.insert({
      kind,
      resourceKey,
      version,
      action,
      state,
      isSecret,
      secret: isSecret ? secret : null,
      rolledBackFrom,
      reason: reason ? String(reason).slice(0, 500) : null,
      changedBy: { type: by.type, id: by.id },
    });
  } catch (error) {
    if (error?.code === 11000) throw versionConflict(version);
    throw error;
  }
}

/** Paginated public history for one resource, newest first. */
export async function listHistory({ kind, resourceKey, page = 1, limit = 20 }) {
  const result = await revisionRepository.list({ kind, resourceKey, page, limit });
  return { ...result, docs: result.docs.map(publicRevision) };
}

/** The raw revision (internal use: rollback). Throws 404 when absent. */
export async function getRevision({ kind, resourceKey, version }) {
  const revision = await revisionRepository.findVersion({ kind, resourceKey, version });
  if (!revision) {
    throw configError(404, CONFIG_ERROR_CODES.REVISION_NOT_FOUND, `Version ${version} was not found in this history`);
  }
  return revision;
}

/**
 * Audit one configuration change. `before` / `after` must already be free
 * of secret values. Never throws.
 */
export async function auditChange({ actor, action, module, resource, before = null, after = null, reason = null, tenantId = null }) {
  try {
    await auditLogService.emit({
      actor: actorOf(actor),
      action,
      module,
      resource,
      before,
      after,
      reason: reason ?? undefined,
      tenantId,
    });
  } catch (error) {
    logger.error({ err: { message: error?.message }, action, module }, 'configuration audit write failed');
  }
}

export default {
  CONFIG_ERROR_CODES,
  versionConflict,
  configError,
  actorOf,
  publicRevision,
  ensureBaseline,
  recordRevision,
  listHistory,
  getRevision,
  auditChange,
};
