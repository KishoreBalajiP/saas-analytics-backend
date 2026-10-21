/**
 * Admin Invitation Service (roadmap 2.2, adminauth; finding adm.09).
 *
 * PURPOSE
 *   Platform admins are invited by email instead of being created with a
 *   password typed by someone else. Inviting creates the Admin record in
 *   status `pending` with NO password (it cannot sign in) plus one
 *   `AdminInvitation`; the emailed link opens the frontend page
 *   `/admin/accept-invite?token=...`, where the invitee chooses a password.
 *   Accepting activates the account and signs the invitee in; a privileged
 *   admin (MFA policy, `adminMfaPolicy.js`) gets a session restricted to MFA
 *   enrolment, so enrolment is the next step.
 *
 * RESPONSIBILITY
 *   - issue({ admin, by })            -> first invitation for a pending admin
 *   - resend({ adminId, by })         -> new token (old one stops working),
 *                                        cooldown persisted in MongoDB
 *   - revoke({ adminId, by, reason }) -> invitation revoked, the pending
 *                                        (never activated) admin removed
 *   - list({ status, page, limit })   -> invitation history
 *   - preview({ token })              -> what the invitee is accepting
 *   - accept({ token, password, name, ip, userAgent }) -> activate + session
 *   Privilege checks for WHO may invite (e.g. super admins) live in
 *   `admin.service.invite`, which calls `issue`.
 *
 * SECURITY RULES
 *   - Tokens are 32 random bytes (base64url); only SHA-256 digests are
 *     stored; a token works once (atomic claim) and until
 *     `ADMIN_INVITATION_TTL_MS` (default 72 h).
 *   - Every invalid case (unknown, expired, used, revoked, admin no longer
 *     pending) answers the same 400, so the endpoint is not an oracle.
 *   - Every step emits a security event (the AdminInvitation model has no
 *     audit plugin because its snapshot would copy the token digest).
 */

import { createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { createChildLogger } from '../utils/logger.js';
import { hash as hashPassword } from '../utils/password.js';
import { describeDuration } from '../utils/humanDuration.js';
import emailService from './email.service.js';
import outboxService from './outbox.service.js';
import authCooldownService from './authCooldown.service.js';
import { securityEvent } from './securityEvent.service.js';
import adminRepository from '../repositories/admin.repository.js';
import adminInvitationRepository from '../repositories/adminInvitation.repository.js';
import authService from '../modules/iam/auth/auth.service.js';
import adminMfaPolicy from '../modules/iam/auth/adminMfaPolicy.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../models/Session.js';

const logger = createChildLogger({ module: 'services/admin_invitation' });
const AUTH = env.security.auth;
const INVALID = 'Invitation link is invalid or has expired';
const MIN_PASSWORD_LENGTH = 8;

/** Frontend path of the invitation acceptance page. */
export const ACCEPT_PATH = '/admin/accept-invite';

function digest(token) {
  if (typeof token !== 'string' || token.length < 20) return '';
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function acceptUrl(token) {
  return `${env.cors.clientUrl}${ACCEPT_PATH}?token=${encodeURIComponent(token)}`;
}

/** Persistent per-admin resend cooldown key (shared by all instances). */
function cooldownKey(adminId) {
  return `admin-invitation-resend:${String(adminId)}`;
}

/** Security-event actor: the acting admin, or the system for internal calls. */
function actorOf(by) {
  return by && /^[0-9a-fA-F]{24}$/.test(String(by)) ? { type: 'admin', id: String(by) } : { type: 'system', id: null };
}

/** Public view of an invitation row (never the token digest). */
export function toPublicInvitation(row, now = new Date()) {
  if (!row) return row;
  const { tokenHash: _omit, __v: _v, ...rest } = row;
  const expired = rest.status === 'pending' && rest.expiresAt && new Date(rest.expiresAt) <= now;
  return { ...rest, id: String(rest._id), status: expired ? 'expired' : rest.status };
}

/**
 * Email the invitation. Reports whether the message reached a transport:
 * with no mail transport configured nothing is claimed as sent.
 */
async function sendInvitationEmail({ admin, token, privileged }) {
  if (!emailService.isCapturing() && !emailService.isDeliveryConfigured()) {
    logger.warn({ reason: 'mail_unconfigured' }, 'admin invitation email not delivered: no mail transport configured');
    return false;
  }
  try {
    // Through the email outbox (retried by the email job if this attempt fails).
    const outcome = await outboxService.sendNow({
      to: admin.email,
      template: 'admin.invitation',
      variables: {
        name: admin.profile?.name || '',
        adminType: admin.adminType,
        acceptUrl: acceptUrl(token),
        expiresIn: describeDuration(AUTH.adminInvitationTtlMs),
        mfaNotice: privileged
          ? 'Your role requires multi-factor authentication: you will set up an authenticator app right after choosing your password.'
          : '',
      },
    });
    return outcome.status === 'sent';
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'admin invitation email delivery failed');
    return false;
  }
}

/**
 * Create and send the first invitation for a pending, passwordless admin.
 *
 * @param {Object} params
 * @param {Object} params.admin - lean admin document (status `pending`).
 * @param {string|null} [params.by] - inviting admin id.
 * @returns {Promise<{ invitation: Object, delivered: boolean }>}
 */
export async function issue({ admin, by = null }) {
  const token = newToken();
  const now = new Date();
  const row = await adminInvitationRepository.create({
    adminId: String(admin._id),
    email: admin.email,
    adminType: admin.adminType,
    invitedBy: by ?? null,
    tokenHash: digest(token),
    status: 'pending',
    expiresAt: new Date(now.getTime() + AUTH.adminInvitationTtlMs),
    sendCount: 1,
    lastSentAt: now,
  });
  // The first send starts the resend cooldown.
  await authCooldownService.acquire(cooldownKey(admin._id), AUTH.adminInvitationResendCooldownMs);
  const privileged = await adminMfaPolicy.isMfaRequired(admin);
  const delivered = await sendInvitationEmail({ admin, token, privileged });
  await adminInvitationRepository.markDelivered(row._id, delivered);
  await securityEvent('ADMIN_INVITATION_CREATED', {
    actor: actorOf(by),
    metadata: { adminId: String(admin._id), adminType: admin.adminType, delivered },
  });
  logger.info({ adminId: String(admin._id), delivered }, 'admin invitation issued');
  return { invitation: toPublicInvitation({ ...row, delivered }), delivered };
}

/**
 * Send a fresh link for a pending invitation; the previous link stops
 * working. Refused with 429 within `ADMIN_INVITATION_RESEND_COOLDOWN_MS` of
 * the last send (persisted, so it holds across instances and restarts).
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string|null} [params.by]
 * @returns {Promise<{ invitation: Object, delivered: boolean }>}
 */
export async function resend({ adminId, by = null }) {
  const admin = await adminRepository.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');
  const pending = await adminInvitationRepository.findPendingForAdmin(adminId);
  if (!pending || admin.status !== 'pending') {
    throw ApiError.notFound('This admin has no pending invitation');
  }
  if (!(await authCooldownService.acquire(cooldownKey(adminId), AUTH.adminInvitationResendCooldownMs))) {
    throw ApiError.tooManyRequests('The invitation was sent recently. Please wait before sending it again.');
  }
  const token = newToken();
  const now = new Date();
  const row = await adminInvitationRepository.rotateToken(pending._id, {
    tokenHash: digest(token),
    expiresAt: new Date(now.getTime() + AUTH.adminInvitationTtlMs),
    now,
  });
  if (!row) throw ApiError.conflict('The invitation changed; reload and try again');
  const privileged = await adminMfaPolicy.isMfaRequired(admin);
  const delivered = await sendInvitationEmail({ admin, token, privileged });
  await adminInvitationRepository.markDelivered(row._id, delivered);
  await securityEvent('ADMIN_INVITATION_RESENT', {
    actor: actorOf(by),
    metadata: { adminId: String(adminId), sendCount: row.sendCount, delivered },
  });
  return { invitation: toPublicInvitation({ ...row, delivered }), delivered };
}

/**
 * Revoke a pending invitation. The never-activated admin record (and any
 * role grants prepared for it) is removed, so the email can be invited
 * again; the invitation row stays as history.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string|null} [params.by]
 * @param {string|null} [params.reason]
 * @returns {Promise<{ invitation: Object, adminRemoved: boolean }>}
 */
export async function revoke({ adminId, by = null, reason = null }) {
  const pending = await adminInvitationRepository.findPendingForAdmin(adminId);
  if (!pending) throw ApiError.notFound('This admin has no pending invitation');
  const row = await adminInvitationRepository.markRevoked(pending._id, { by, reason });
  if (!row) throw ApiError.conflict('The invitation changed; reload and try again');
  const removed = await adminRepository.deletePending(adminId);
  await securityEvent('ADMIN_INVITATION_REVOKED', {
    actor: actorOf(by),
    reason: reason ?? undefined,
    metadata: { adminId: String(adminId), adminRemoved: removed > 0 },
  });
  return { invitation: toPublicInvitation(row), adminRemoved: removed > 0 };
}

/**
 * Invitation history, newest first. `status: 'expired'` matches pending
 * rows past their expiry (expiry is evaluated at read time).
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>} paginated list.
 */
export async function list({ status, page = 1, limit = 20 } = {}) {
  const now = new Date();
  let filter = {};
  if (status === 'pending') filter = { status: 'pending', expiresAt: { $gt: now } };
  else if (status === 'expired') filter = { $or: [{ status: 'expired' }, { status: 'pending', expiresAt: { $lte: now } }] };
  else if (status) filter = { status };
  const result = await adminInvitationRepository.list({ filter, page, limit });
  return { ...result, docs: result.docs.map((row) => toPublicInvitation(row, now)) };
}

/** Load the live invitation and its still-pending admin, or throw the generic 400. */
async function loadLive(token) {
  const tokenHash = digest(token);
  if (!tokenHash) throw ApiError.badRequest(INVALID);
  const row = await adminInvitationRepository.findLiveByTokenHash(tokenHash);
  if (!row) throw ApiError.badRequest(INVALID);
  const admin = await adminRepository.findById(row.adminId);
  if (!admin || admin.status !== 'pending') throw ApiError.badRequest(INVALID);
  return { row, admin, tokenHash };
}

/**
 * What the invitee is accepting (for the acceptance page).
 *
 * @param {Object} params
 * @param {string} params.token
 * @returns {Promise<{ email: string, name: string, adminType: string, expiresAt: Date, mfaRequired: boolean }>}
 */
export async function preview({ token }) {
  const { row, admin } = await loadLive(token);
  return {
    email: admin.email,
    name: admin.profile?.name ?? '',
    adminType: admin.adminType,
    expiresAt: row.expiresAt,
    mfaRequired: await adminMfaPolicy.isMfaRequired(admin),
  };
}

/**
 * Accept an invitation: set the password, activate the account and sign
 * the invitee in. Privileged admins get an enrolment-only session.
 *
 * @param {Object} params
 * @param {string} params.token
 * @param {string} params.password
 * @param {string} [params.name]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<Object>} the `authService.startSession` result.
 */
export async function accept({ token, password, name = '', ip = '', userAgent = '' }) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw ApiError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // Validate before hashing (cheap reads first), then claim atomically.
  const { admin, tokenHash } = await loadLive(token);
  const passwordHash = await hashPassword(password);
  const claimed = await adminInvitationRepository.claimByTokenHash(tokenHash);
  if (!claimed || String(claimed.adminId) !== String(admin._id)) throw ApiError.badRequest(INVALID);

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const activated = await adminRepository.activateInvited(admin._id, { passwordHash, name: trimmedName || null });
  if (!activated) throw ApiError.badRequest(INVALID);
  await adminRepository.touchLastLogin(String(activated._id));

  const mfaRequired = await adminMfaPolicy.isMfaRequired(activated);
  const result = await authService.startSession({
    portal: 'admin',
    account: activated,
    restriction: mfaRequired ? SESSION_RESTRICTION_MFA_ENROLLMENT : null,
    ip,
    userAgent,
  });
  await securityEvent('ADMIN_INVITATION_ACCEPTED', {
    actor: { type: 'admin', id: String(activated._id) },
    metadata: { invitationId: String(claimed._id), adminType: activated.adminType, mfaEnrollmentRequired: mfaRequired },
  });
  logger.info({ adminId: String(activated._id), mfaRequired }, 'admin invitation accepted');
  return result;
}

export default {
  issue,
  resend,
  revoke,
  list,
  preview,
  accept,
  toPublicInvitation,
  ACCEPT_PATH,
  _meta: { token: 'opaque-single-use-sha256', delivery: 'email', cooldown: 'mongodb' },
};
