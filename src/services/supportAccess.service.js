/**
 * Support Access Service (roadmap 2.3 - consented, time-boxed support access).
 *
 * PURPOSE
 *   Decides WHEN platform support may open a read-only impersonation session
 *   into a workspace, and keeps the workspace-visible record of it.
 *
 * MODEL
 *   - Consent: a workspace Owner/Admin (`settings.configure`) grants support
 *     access for a bounded window (1..SUPPORT_CONSENT_MAX_HOURS hours) and can
 *     revoke it at any time. Revoking ends every open support session that
 *     used the grant.
 *   - Break-glass: for an incident where the workspace cannot consent, a
 *     support admin requests access with a reason; a DIFFERENT, active,
 *     unscoped super admin approves it (`support.approve`). The grant lasts
 *     SUPPORT_BREAK_GLASS_TTL, is usable only by the requesting admin, and
 *     every session and audit row it produces is flagged `breakGlass`.
 *   - Impersonation is refused (403 SUPPORT_CONSENT_REQUIRED) without a
 *     usable grant, for a non-active workspace (409 TENANT_NOT_ACTIVE), for a
 *     target that belongs to platform staff (403 SUPPORT_TARGET_PROTECTED)
 *     and outside the admin's tenant scope (403).
 *   - The per-admin daily cap is one conditional atomic increment
 *     (`incrementDailyCounter`), so concurrent starts cannot exceed it.
 *
 * TRANSPARENCY
 *   Every grant, decision, revocation, refused attempt and session start/end
 *   writes a tenant-scoped audit row (`support.access` /
 *   `support.impersonation`). The workspace reads its grants, sessions and
 *   support activity through `/api/v1/workspace/support-access`.
 *
 * SECURITY RULES
 *   - Admin identity and tenant scope are re-read from the database, never
 *     taken from the JWT.
 *   - Views returned to the workspace never include IPs, user agents or
 *   audit before/after payloads.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { parseExpiresIn } from '../utils/jwt.js';
import { ERROR_CODES } from '../config/constants.js';
import {
  SUPPORT_ERROR_CODES,
  SUPPORT_AUDIT_MODULES,
  CONSENT_MIN_HOURS,
} from '../constants/support.js';
import supportAccessRepository from '../repositories/supportAccess.repository.js';
import adminRepository from '../repositories/admin.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import { emit as emitAudit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';

const HOUR_MS = 60 * 60 * 1000;

/* ------------------------------ internals -------------------------------- */

function typedError(statusCode, message, code) {
  return new ApiError(statusCode, message, { code });
}

/** Never let a security-event failure (or an unknown key) break the action. */
async function emitSecurityEvent(key, opts) {
  try {
    await securityEvent(key, opts);
  } catch (err) {
    logger.warn({ err: { message: err?.message }, key }, 'support security event failed');
  }
}

function adminDisplay(adminDoc) {
  const name = adminDoc?.profile?.name ? String(adminDoc.profile.name).trim() : '';
  return name || adminDoc?.email || String(adminDoc?._id ?? '');
}

function adminActor(adminDoc) {
  return { type: 'admin', id: String(adminDoc._id), display: adminDisplay(adminDoc) };
}

/** A grant's status as the workspace and the console should read it. */
function effectiveGrantStatus(grant, now = new Date()) {
  if (grant.status === 'active' && grant.expiresAt && new Date(grant.expiresAt) <= now) return 'expired';
  return grant.status;
}

function grantView(grant, now = new Date()) {
  if (!grant) return null;
  return {
    id: grant.grantId,
    tenantId: grant.tenantId,
    kind: grant.kind,
    breakGlass: grant.kind === 'break_glass',
    status: effectiveGrantStatus(grant, now),
    reason: grant.reason ?? null,
    ticket: grant.ticket ?? null,
    grantedBy: grant.grantedBy ? { id: grant.grantedBy, display: grant.grantedByDisplay ?? null } : null,
    requestedBy: grant.requestedBy ? { id: grant.requestedBy, display: grant.requestedByDisplay ?? null } : null,
    decidedBy: grant.decidedBy ? { id: grant.decidedBy, display: grant.decidedByDisplay ?? null } : null,
    decidedAt: grant.decidedAt ?? null,
    decisionReason: grant.decisionReason ?? null,
    startsAt: grant.startsAt ?? null,
    expiresAt: grant.expiresAt ?? null,
    revokedAt: grant.revokedAt ?? null,
    revokedByType: grant.revokedByType ?? null,
    revokedReason: grant.revokedReason ?? null,
    createdAt: grant.createdAt ?? null,
  };
}

function impersonationView(record, sessionState, now = new Date()) {
  let status = record.status;
  if (status === 'active') {
    if (new Date(record.expiresAt) <= now) status = 'expired';
    // The backing session can end without the record (tenant suspended,
    // sessions revoked for the user): report what is true now.
    else if (sessionState !== undefined && (!sessionState || sessionState.status !== 'active')) status = 'ended';
  }
  return {
    id: record.sessionId,
    tenantId: record.tenantId,
    status,
    user: { id: record.userId, display: record.userDisplay ?? null },
    operator: { id: record.adminId, display: record.adminDisplay ?? null },
    grantId: record.grantId,
    kind: record.kind,
    breakGlass: record.breakGlass === true,
    readOnly: record.readOnly !== false,
    reason: record.reason,
    ticket: record.ticket ?? null,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    endedAt: record.endedAt ?? null,
    endedReason: record.endedReason ?? null,
  };
}

async function impersonationViews(records, now = new Date()) {
  const open = records.filter((r) => r.status === 'active' && new Date(r.expiresAt) > now);
  const states = await supportAccessRepository.sessionStatuses(open.map((r) => r.sessionId));
  return records.map((r) => impersonationView(
    r,
    open.includes(r) ? (states[r.sessionId] ?? null) : undefined,
    now,
  ));
}

function auditRowView(row) {
  return {
    id: String(row._id),
    occurredAt: row.occurredAt,
    module: row.module,
    action: row.action,
    result: row.result,
    actor: { type: row.actorType, id: row.actorId ?? null, display: row.actorDisplay || null },
    impersonatedBy: row.impersonatedBy ?? null,
    resource: row.resourceType ? { type: row.resourceType, id: row.resourceId ?? null } : null,
    reason: row.reason ?? null,
  };
}

/* ---------------------------- admin identity ----------------------------- */

/**
 * Re-read the acting admin from the database (scope and type come from the
 * persisted record, never the JWT). Inactive admins are refused.
 */
export async function resolveAdmin(actor) {
  const doc = actor?.id ? await adminRepository.findById(actor.id) : null;
  if (!doc || doc.deletedAt) throw ApiError.forbidden('Admin no longer exists');
  if (doc.status && doc.status !== 'active') throw ApiError.forbidden('Admin account is not active');
  return doc;
}

/** Platform admins act anywhere; tenant-scoped admins only inside their tenant. */
export function assertAdminInScope(adminDoc, tenantId) {
  if (adminDoc.tenantScope && String(tenantId) !== String(adminDoc.tenantScope)) {
    throw ApiError.forbidden('Target is outside your tenant scope');
  }
}

/** Resolve a live (not deleted) tenant, in the admin's scope. */
export async function resolveTenantInScope(adminDoc, tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  assertAdminInScope(adminDoc, tenantId);
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  return tenant;
}

/* ------------------------- consent (workspace side) ----------------------- */

/**
 * A workspace Owner/Admin grants support access for `durationHours`. A new
 * consent supersedes any active one.
 */
export async function grantConsent({ tenantId, user, durationHours, note = null, ip, userAgent, requestId }) {
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  if (!user?.id) throw ApiError.forbidden('Authenticated workspace user is required');
  const maxHours = env.support.consentMaxHours;
  const hours = Number(durationHours);
  if (!Number.isInteger(hours) || hours < CONSENT_MIN_HOURS || hours > maxHours) {
    throw ApiError.badRequest(`durationHours must be an integer between ${CONSENT_MIN_HOURS} and ${maxHours}`, [
      { field: 'durationHours', message: `must be between ${CONSENT_MIN_HOURS} and ${maxHours}` },
    ]);
  }
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');

  const now = new Date();
  const superseded = await supportAccessRepository.revokeActiveConsents({
    tenantId,
    by: String(user.id),
    byType: 'user',
    reason: 'superseded by a new consent',
    now,
  });
  const grant = await supportAccessRepository.createGrant({
    tenantId: String(tenantId),
    kind: 'consent',
    status: 'active',
    reason: note ? String(note).trim().slice(0, 500) : null,
    grantedBy: String(user.id),
    grantedByDisplay: user.email ?? null,
    startsAt: now,
    expiresAt: new Date(now.getTime() + hours * HOUR_MS),
  });

  await emitAudit({
    actor: { type: 'user', id: String(user.id), display: user.email ?? null },
    action: 'grant.created',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    after: { kind: 'consent', durationHours: hours, expiresAt: grant.expiresAt, superseded },
    reason: grant.reason,
    tenantId: String(tenantId),
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_ACCESS_GRANTED', {
    actor: { type: 'user', id: String(user.id) },
    tenantId: String(tenantId),
    metadata: { grantId: grant.grantId, kind: 'consent', expiresAt: grant.expiresAt },
  });
  return grantView(grant, now);
}

/**
 * End a grant and every support session opened under it. Shared by the
 * workspace (consent only) and the admin console.
 */
async function revokeGrantAndSessions({ grant, by, byType, reason, now = new Date() }) {
  if (!['active', 'pending'].includes(effectiveGrantStatus(grant, now))) {
    throw typedError(409, 'This grant is no longer active', SUPPORT_ERROR_CODES.SUPPORT_GRANT_NOT_ACTIVE);
  }
  const updated = await supportAccessRepository.transitionGrant({
    grantId: grant.grantId,
    tenantId: grant.tenantId,
    fromStatuses: ['active', 'pending'],
    set: { status: 'revoked', revokedAt: now, revokedBy: by, revokedByType: byType, revokedReason: reason ?? null },
  });
  if (!updated) {
    throw typedError(409, 'This grant is no longer active', SUPPORT_ERROR_CODES.SUPPORT_GRANT_NOT_ACTIVE);
  }
  const endedSessions = await endSessionsForGrant(grant.grantId, { endedBy: by, reason: 'support access revoked' });
  return { grant: updated, endedSessions };
}

/** Revoke the backing sessions and close the records of a grant. */
async function endSessionsForGrant(grantId, { endedBy, reason }) {
  const open = await supportAccessRepository.findActiveImpersonationsForGrant(grantId);
  for (const record of open) {
    await sessionRepository.revoke(record.sessionId, 'support_access_revoked');
    await supportAccessRepository.endImpersonation(record.sessionId, { endedBy, reason });
  }
  return open.map((r) => r.sessionId);
}

/** The workspace revokes one of its consents (break-glass grants are revoked by platform staff). */
export async function revokeConsent({ tenantId, grantId, user, reason = null, ip, userAgent, requestId }) {
  const grant = await supportAccessRepository.findGrant(grantId, { tenantId });
  if (!grant) throw ApiError.notFound('Support access grant not found');
  if (grant.kind !== 'consent') {
    throw ApiError.forbidden('Break-glass access is managed by platform administrators');
  }
  const now = new Date();
  const { grant: updated, endedSessions } = await revokeGrantAndSessions({
    grant,
    by: String(user.id),
    byType: 'user',
    reason: reason ? String(reason).trim().slice(0, 500) : 'revoked by the workspace',
    now,
  });
  await emitAudit({
    actor: { type: 'user', id: String(user.id), display: user.email ?? null },
    action: 'grant.revoked',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    after: { kind: grant.kind, endedSessions },
    reason: updated.revokedReason,
    tenantId: String(tenantId),
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_ACCESS_REVOKED', {
    actor: { type: 'user', id: String(user.id) },
    tenantId: String(tenantId),
    metadata: { grantId: grant.grantId, kind: grant.kind, endedSessions: endedSessions.length },
  });
  return { ...grantView(updated, now), endedSessions };
}

/** Workspace view: the usable grant, recent grants and recent support sessions. */
export async function getWorkspaceSupportAccess({ tenantId, page = 1, limit = 10 }) {
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const now = new Date();
  const [active, grants, sessions] = await Promise.all([
    supportAccessRepository.findActiveGrant({ tenantId, now }),
    supportAccessRepository.listGrants({ tenantId, page, limit }),
    supportAccessRepository.listImpersonations({ tenantId, page: 1, limit }),
  ]);
  return {
    active: grantView(active, now),
    grants: grants.docs.map((g) => grantView(g, now)),
    grantsMeta: { page: grants.page, limit: grants.limit, total: grants.total, pages: grants.pages },
    sessions: await impersonationViews(sessions.docs, now),
    maxHours: env.support.consentMaxHours,
  };
}

/** Workspace view: support-related audit history of the tenant (paginated). */
export async function listWorkspaceSupportActivity({ tenantId, page = 1, limit = 20 }) {
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const result = await supportAccessRepository.listSupportAuditRows({ tenantId, page, limit });
  return { ...result, docs: result.docs.map(auditRowView) };
}

/* ------------------------- break-glass (admin side) ----------------------- */

/** A support admin asks for incident access to a workspace without consent. */
export async function requestBreakGlass({ actor, tenantId, reason, ticket = null, ip, userAgent, requestId }) {
  if (!reason || String(reason).trim().length < 10) {
    throw ApiError.badRequest('A reason of at least 10 characters is required for break-glass access', [
      { field: 'reason', message: 'must be at least 10 characters' },
    ]);
  }
  const adminDoc = await resolveAdmin(actor);
  const tenant = await resolveTenantInScope(adminDoc, tenantId);
  const grant = await supportAccessRepository.createGrant({
    tenantId: String(tenant._id),
    kind: 'break_glass',
    status: 'pending',
    reason: String(reason).trim().slice(0, 500),
    ticket: ticket ? String(ticket).trim().slice(0, 120) : null,
    requestedBy: String(adminDoc._id),
    requestedByDisplay: adminDisplay(adminDoc),
  });
  await emitAudit({
    actor: adminActor(adminDoc),
    action: 'break_glass.requested',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    after: { kind: 'break_glass', ticket: grant.ticket },
    reason: grant.reason,
    tenantId: String(tenant._id),
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_BREAK_GLASS_REQUESTED', {
    actor: { type: 'admin', id: String(adminDoc._id) },
    tenantId: String(tenant._id),
    reason: grant.reason,
    metadata: { grantId: grant.grantId, ticket: grant.ticket },
  });
  return grantView(grant);
}

/**
 * An approver may decide a break-glass request only when they are an active,
 * unscoped super admin and not the requester (four-eyes).
 */
function assertEligibleApprover(adminDoc, grant) {
  if (adminDoc.adminType !== 'super' || adminDoc.tenantScope) {
    throw typedError(403, 'Only a platform super admin can decide break-glass access', SUPPORT_ERROR_CODES.BREAK_GLASS_APPROVAL_DENIED);
  }
  if (String(adminDoc._id) === String(grant.requestedBy)) {
    throw typedError(403, 'A break-glass request must be approved by a different admin', SUPPORT_ERROR_CODES.BREAK_GLASS_APPROVAL_DENIED);
  }
}

/**
 * Lifetime of an approved break-glass grant: SUPPORT_BREAK_GLASS_TTL,
 * clamped to 1 minute .. 24 hours; a malformed value falls back to 1 hour.
 */
function breakGlassTtlSeconds() {
  let seconds;
  try {
    seconds = parseExpiresIn(env.support.breakGlassTtl ?? '1h');
  } catch {
    seconds = HOUR_MS / 1000;
  }
  return Math.min(Math.max(60, seconds), 24 * 60 * 60);
}

/** Approve a pending break-glass request; it becomes usable for SUPPORT_BREAK_GLASS_TTL. */
export async function approveBreakGlass({ actor, grantId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required to approve break-glass access');
  const adminDoc = await resolveAdmin(actor);
  const grant = await supportAccessRepository.findGrant(grantId);
  if (!grant || grant.kind !== 'break_glass') throw ApiError.notFound('Break-glass request not found');
  assertAdminInScope(adminDoc, grant.tenantId);
  assertEligibleApprover(adminDoc, grant);

  const now = new Date();
  const ttlSeconds = breakGlassTtlSeconds();
  const updated = await supportAccessRepository.transitionGrant({
    grantId: grant.grantId,
    fromStatuses: ['pending'],
    set: {
      status: 'active',
      decidedBy: String(adminDoc._id),
      decidedByDisplay: adminDisplay(adminDoc),
      decidedAt: now,
      decisionReason: String(reason).trim().slice(0, 500),
      startsAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
  });
  if (!updated) throw typedError(409, 'This break-glass request was already decided', SUPPORT_ERROR_CODES.SUPPORT_GRANT_NOT_ACTIVE);

  await emitAudit({
    actor: adminActor(adminDoc),
    action: 'break_glass.approved',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    after: { kind: 'break_glass', breakGlass: true, requestedBy: grant.requestedBy, expiresAt: updated.expiresAt },
    reason: updated.decisionReason,
    tenantId: grant.tenantId,
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_BREAK_GLASS_APPROVED', {
    actor: { type: 'admin', id: String(adminDoc._id) },
    tenantId: grant.tenantId,
    reason: updated.decisionReason,
    metadata: { grantId: grant.grantId, requestedBy: grant.requestedBy, expiresAt: updated.expiresAt },
  });
  return grantView(updated, now);
}

/** Deny a pending break-glass request. */
export async function denyBreakGlass({ actor, grantId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required to deny break-glass access');
  const adminDoc = await resolveAdmin(actor);
  const grant = await supportAccessRepository.findGrant(grantId);
  if (!grant || grant.kind !== 'break_glass') throw ApiError.notFound('Break-glass request not found');
  assertAdminInScope(adminDoc, grant.tenantId);
  assertEligibleApprover(adminDoc, grant);

  const now = new Date();
  const updated = await supportAccessRepository.transitionGrant({
    grantId: grant.grantId,
    fromStatuses: ['pending'],
    set: {
      status: 'denied',
      decidedBy: String(adminDoc._id),
      decidedByDisplay: adminDisplay(adminDoc),
      decidedAt: now,
      decisionReason: String(reason).trim().slice(0, 500),
    },
  });
  if (!updated) throw typedError(409, 'This break-glass request was already decided', SUPPORT_ERROR_CODES.SUPPORT_GRANT_NOT_ACTIVE);

  await emitAudit({
    actor: adminActor(adminDoc),
    action: 'break_glass.denied',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    reason: updated.decisionReason,
    tenantId: grant.tenantId,
    result: 'success',
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_BREAK_GLASS_DENIED', {
    actor: { type: 'admin', id: String(adminDoc._id) },
    tenantId: grant.tenantId,
    metadata: { grantId: grant.grantId },
  });
  return grantView(updated, now);
}

/** Platform staff give up (revoke) a grant early - it only ever reduces access. */
export async function revokeGrantAsAdmin({ actor, grantId, reason, ip, userAgent, requestId }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required to revoke support access');
  const adminDoc = await resolveAdmin(actor);
  const grant = await supportAccessRepository.findGrant(grantId);
  if (!grant) throw ApiError.notFound('Support access grant not found');
  assertAdminInScope(adminDoc, grant.tenantId);
  const now = new Date();
  const { grant: updated, endedSessions } = await revokeGrantAndSessions({
    grant,
    by: String(adminDoc._id),
    byType: 'admin',
    reason: String(reason).trim().slice(0, 500),
    now,
  });
  await emitAudit({
    actor: adminActor(adminDoc),
    action: 'grant.revoked',
    module: SUPPORT_AUDIT_MODULES.ACCESS,
    resource: { type: 'supportAccessGrant', id: grant.grantId },
    after: { kind: grant.kind, endedSessions },
    reason: updated.revokedReason,
    tenantId: grant.tenantId,
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_ACCESS_REVOKED', {
    actor: { type: 'admin', id: String(adminDoc._id) },
    tenantId: grant.tenantId,
    metadata: { grantId: grant.grantId, kind: grant.kind, endedSessions: endedSessions.length },
  });
  return { ...grantView(updated, now), endedSessions };
}

/** Console listing of grants (scoped admins only see their tenant). */
export async function listGrantsForAdmin({ actor, tenantId, status, kind, page = 1, limit = 20 }) {
  const adminDoc = await resolveAdmin(actor);
  let scopeTenant = tenantId ? String(tenantId) : null;
  if (adminDoc.tenantScope) {
    if (scopeTenant && scopeTenant !== String(adminDoc.tenantScope)) {
      throw ApiError.forbidden('Target is outside your tenant scope');
    }
    scopeTenant = String(adminDoc.tenantScope);
  }
  const now = new Date();
  const result = await supportAccessRepository.listGrants({ tenantId: scopeTenant, status, kind, page, limit });
  return { ...result, docs: result.docs.map((g) => grantView(g, now)) };
}

/** Console listing of support sessions (scoped admins only see their tenant). */
export async function listImpersonationsForAdmin({ actor, tenantId, status, mine = false, page = 1, limit = 20 }) {
  const adminDoc = await resolveAdmin(actor);
  let scopeTenant = tenantId ? String(tenantId) : null;
  if (adminDoc.tenantScope) {
    if (scopeTenant && scopeTenant !== String(adminDoc.tenantScope)) {
      throw ApiError.forbidden('Target is outside your tenant scope');
    }
    scopeTenant = String(adminDoc.tenantScope);
  }
  const now = new Date();
  const result = await supportAccessRepository.listImpersonations({
    tenantId: scopeTenant,
    adminId: mine ? String(adminDoc._id) : undefined,
    activeAt: status === 'active' ? now : undefined,
    status: status === 'ended' ? 'ended' : undefined,
    page,
    limit,
  });
  return { ...result, docs: await impersonationViews(result.docs, now) };
}

/* ------------------------- impersonation gate ----------------------------- */

/**
 * Everything that must hold before a support admin may open a session as
 * `user`: an active workspace, a target that is not platform staff, and a
 * usable consent or (own, approved) break-glass grant. Refusals for missing
 * consent are recorded on the tenant's audit trail.
 *
 * @returns {Promise<{ tenant: Object, grant: Object }>}
 */
export async function authorizeImpersonation({ adminDoc, user, ip, userAgent, requestId, now = new Date() }) {
  const tenant = await tenantRepository.findById(user.tenantId);
  if (!tenant || tenant.deletedAt) throw ApiError.notFound('Tenant not found');
  if (tenant.status !== 'active') {
    throw typedError(409, 'The workspace is not active; support sessions are blocked', ERROR_CODES.TENANT_NOT_ACTIVE);
  }
  if (user.status !== 'active') {
    throw typedError(409, 'Only active users can be viewed in a support session', ERROR_CODES.ACCOUNT_NOT_ACTIVE);
  }
  await assertTargetNotProtected({ user, tenant });

  // Consent first; otherwise the admin's own approved break-glass grant.
  const grant = (await supportAccessRepository.findActiveGrant({ tenantId: user.tenantId, kind: 'consent', now }))
    ?? (await supportAccessRepository.findActiveGrant({
      tenantId: user.tenantId,
      kind: 'break_glass',
      requestedBy: String(adminDoc._id),
      now,
    }));
  if (!grant) {
    await emitAudit({
      actor: adminActor(adminDoc),
      action: 'impersonate.refused',
      module: SUPPORT_AUDIT_MODULES.IMPERSONATION,
      resource: { type: 'user', id: String(user._id) },
      tenantId: String(user.tenantId),
      result: 'failure',
      errorCode: SUPPORT_ERROR_CODES.SUPPORT_CONSENT_REQUIRED,
      ip,
      userAgent,
      requestId,
    });
    await emitSecurityEvent('SUPPORT_IMPERSONATION_REFUSED', {
      actor: { type: 'admin', id: String(adminDoc._id) },
      tenantId: String(user.tenantId),
      metadata: { userId: String(user._id), code: SUPPORT_ERROR_CODES.SUPPORT_CONSENT_REQUIRED },
    });
    throw typedError(
      403,
      'The workspace has not granted support access. Ask an Owner or Admin to grant it in workspace settings, or request break-glass access.',
      SUPPORT_ERROR_CODES.SUPPORT_CONSENT_REQUIRED,
    );
  }
  return { tenant, grant };
}

/**
 * Support never impersonates platform staff: a target user (or the owner of
 * the target workspace) whose email is a platform admin account is refused.
 */
export async function assertTargetNotProtected({ user, tenant }) {
  const emails = new Set([String(user.email ?? '').toLowerCase()].filter(Boolean));
  if (tenant.ownerId) {
    const owner = await userRepository.findById(tenant.ownerId).catch(() => null);
    if (owner?.email) emails.add(String(owner.email).toLowerCase());
  }
  for (const email of emails) {
    const staff = await adminRepository.findByEmail(email);
    if (staff) {
      throw typedError(403, 'Support sessions cannot target accounts or workspaces owned by platform staff', SUPPORT_ERROR_CODES.SUPPORT_TARGET_PROTECTED);
    }
  }
}

/**
 * Take one slot of the admin's daily impersonation budget atomically.
 * `SUPPORT_IMPERSONATION_DAILY_CAP=0` disables the cap.
 */
export async function reserveImpersonationSlot({ adminId, now = new Date() }) {
  const cap = Number(env.support.impersonationBudgetDailyCap);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const count = await supportAccessRepository.incrementDailyCounter({ adminId, cap, now });
  if (count === null) {
    throw typedError(429, 'Daily impersonation budget exhausted', SUPPORT_ERROR_CODES.SUPPORT_IMPERSONATION_CAP_EXCEEDED);
  }
  return count;
}

/** Return a slot when the session could not be opened after all. */
export async function releaseImpersonationSlot({ adminId, now = new Date() }) {
  const cap = Number(env.support.impersonationBudgetDailyCap);
  if (!Number.isFinite(cap) || cap <= 0) return;
  try {
    await supportAccessRepository.decrementDailyCounter({ adminId, now });
  } catch (err) {
    logger.warn({ err: { message: err?.message } }, 'could not release impersonation budget slot');
  }
}

/** Persist the workspace-visible record of a support session. */
export async function recordImpersonationStart({ sessionId, user, adminDoc, grant, reason, ticket, startedAt, expiresAt }) {
  return supportAccessRepository.createImpersonation({
    sessionId,
    tenantId: String(user.tenantId),
    userId: String(user._id),
    userDisplay: user.email ?? null,
    adminId: String(adminDoc._id),
    adminDisplay: adminDisplay(adminDoc),
    grantId: grant.grantId,
    kind: grant.kind,
    breakGlass: grant.kind === 'break_glass',
    readOnly: true,
    reason: String(reason).trim().slice(0, 500),
    ticket: ticket ? String(ticket).trim().slice(0, 120) : null,
    status: 'active',
    startedAt,
    expiresAt,
  });
}

/** Close the record of a support session (idempotent). */
export async function recordImpersonationEnd({ sessionId, endedBy, reason }) {
  return supportAccessRepository.endImpersonation(sessionId, { endedBy, reason });
}

/** Read the record of one support session. */
export async function findImpersonation(sessionId) {
  return supportAccessRepository.findImpersonationBySession(sessionId);
}

/* --------------------- the support session itself ------------------------ */

/**
 * What the current request's support session is, for the in-product banner.
 * A normal (non-support) session gets `{ active: false }`.
 *
 * @param {{ user: { id: string, sessionId: string, tenantId: string, impersonation?: boolean, impersonatedBy?: string } }} params
 */
export async function getCurrentSupportSession({ user }) {
  if (!user?.impersonation || !user.sessionId) return { active: false };
  const now = new Date();
  const record = await supportAccessRepository.findImpersonationBySession(user.sessionId);
  if (!record || String(record.tenantId) !== String(user.tenantId)) {
    // A support session without a record (opened before roadmap 2.3) is
    // still read-only; report what the session itself proves.
    return {
      active: true,
      sessionId: user.sessionId,
      readOnly: true,
      breakGlass: false,
      operator: { id: user.impersonatedBy ?? null, display: null },
      user: { id: user.id, display: user.email ?? null },
      expiresAt: null,
      startedAt: null,
      reason: null,
      ticket: null,
    };
  }
  const view = impersonationView(record, undefined, now);
  return {
    active: view.status === 'active',
    sessionId: view.id,
    readOnly: true,
    breakGlass: view.breakGlass,
    operator: view.operator,
    user: view.user,
    startedAt: view.startedAt,
    expiresAt: view.expiresAt,
    reason: view.reason,
    ticket: view.ticket,
  };
}

/**
 * A support session ends itself (the "End support session" button in the
 * banner). Authorised by `authenticateImpersonation`, so only a support
 * session reaches here. Recorded as the operator's action.
 */
export async function endCurrentSupportSession({ user, reason = null, ip, userAgent, requestId }) {
  if (!user?.impersonation || !user.sessionId) {
    throw typedError(403, 'This endpoint is only for support sessions', SUPPORT_ERROR_CODES.IMPERSONATION_SESSION_REQUIRED);
  }
  const record = await supportAccessRepository.findImpersonationBySession(user.sessionId);
  await sessionRepository.revoke(user.sessionId, 'impersonation_ended');
  const ended = await supportAccessRepository.endImpersonation(user.sessionId, {
    endedBy: user.impersonatedBy ?? null,
    reason: reason ? String(reason).trim().slice(0, 500) : 'ended by the operator',
  });
  await emitAudit({
    actor: {
      type: 'admin',
      id: String(user.impersonatedBy ?? record?.adminId ?? 'unknown'),
      display: record?.adminDisplay ?? null,
    },
    action: 'impersonate.end',
    module: SUPPORT_AUDIT_MODULES.IMPERSONATION,
    resource: { type: 'session', id: user.sessionId },
    after: { userId: user.id, breakGlass: record?.breakGlass === true, endedFrom: 'support_session' },
    reason: ended?.endedReason ?? null,
    tenantId: user.tenantId ?? null,
    impersonatedBy: user.impersonatedBy ?? null,
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_IMPERSONATION_STOPPED', {
    actor: { type: 'admin', id: String(user.impersonatedBy ?? record?.adminId ?? 'unknown') },
    tenantId: user.tenantId ?? null,
    metadata: { sessionId: user.sessionId, endedFrom: 'support_session' },
  });
  return { sessionId: user.sessionId, status: 'ended', endedAt: new Date(ended?.endedAt ?? Date.now()).toISOString() };
}

/**
 * The workspace ends a support session early (Owner/Admin, from workspace
 * settings). Only sessions of this workspace; already ended ones are 409.
 */
export async function endSessionAsWorkspace({ tenantId, sessionId, user, reason = null, ip, userAgent, requestId }) {
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  const record = await supportAccessRepository.findImpersonationBySession(sessionId);
  if (!record || String(record.tenantId) !== String(tenantId)) {
    throw ApiError.notFound('Support session not found');
  }
  const now = new Date();
  if (record.status !== 'active' || new Date(record.expiresAt) <= now) {
    throw typedError(409, 'This support session has already ended', SUPPORT_ERROR_CODES.SUPPORT_GRANT_NOT_ACTIVE);
  }
  await sessionRepository.revoke(record.sessionId, 'impersonation_ended_by_workspace');
  const ended = await supportAccessRepository.endImpersonation(record.sessionId, {
    endedBy: String(user.id),
    reason: reason ? String(reason).trim().slice(0, 500) : 'ended by the workspace',
    now,
  });
  await emitAudit({
    actor: { type: 'user', id: String(user.id), display: user.email ?? null },
    action: 'impersonate.ended_by_workspace',
    module: SUPPORT_AUDIT_MODULES.IMPERSONATION,
    resource: { type: 'session', id: record.sessionId },
    after: { operatorId: record.adminId, breakGlass: record.breakGlass === true },
    reason: ended?.endedReason ?? null,
    tenantId: String(tenantId),
    ip,
    userAgent,
    requestId,
  });
  await emitSecurityEvent('SUPPORT_IMPERSONATION_STOPPED', {
    actor: { type: 'user', id: String(user.id) },
    tenantId: String(tenantId),
    metadata: { sessionId: record.sessionId, operatorId: record.adminId, endedFrom: 'workspace' },
  });
  return impersonationView(ended ?? { ...record, status: 'ended', endedAt: now }, undefined, now);
}

/** Usable grant + open session count of a tenant (for diagnostics). */
export async function supportAccessSummary(tenantId) {
  const now = new Date();
  const [active, pending, openSessions] = await Promise.all([
    supportAccessRepository.findActiveGrant({ tenantId, now }),
    supportAccessRepository.listGrants({ tenantId, status: 'pending', kind: 'break_glass', page: 1, limit: 5 }),
    supportAccessRepository.countActiveImpersonations({ tenantId, now }),
  ]);
  return {
    active: grantView(active, now),
    pendingBreakGlass: pending.docs.map((g) => grantView(g, now)),
    openSessions,
  };
}

export { grantView, impersonationView };

export default {
  resolveAdmin,
  assertAdminInScope,
  resolveTenantInScope,
  grantConsent,
  revokeConsent,
  getWorkspaceSupportAccess,
  listWorkspaceSupportActivity,
  requestBreakGlass,
  approveBreakGlass,
  denyBreakGlass,
  revokeGrantAsAdmin,
  listGrantsForAdmin,
  listImpersonationsForAdmin,
  authorizeImpersonation,
  assertTargetNotProtected,
  reserveImpersonationSlot,
  releaseImpersonationSlot,
  recordImpersonationStart,
  recordImpersonationEnd,
  findImpersonation,
  getCurrentSupportSession,
  endCurrentSupportSession,
  endSessionAsWorkspace,
  supportAccessSummary,
};
