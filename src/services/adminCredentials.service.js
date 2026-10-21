/**
 * Admin-assisted credential resets (roadmap 2.2, adminauth; finding auth.13).
 *
 * PURPOSE
 *   An admin who lost their authenticator (or password) must not depend on
 *   someone editing the database. Another ACTIVE SUPER admin can:
 *   - resetMfa      -> wipe the TOTP secret and recovery codes, revoke every
 *                      session of the target and force MFA enrolment at the
 *                      target's next sign-in (whatever their admin type);
 *   - resetPassword -> void the current password (it stops working at once),
 *                      revoke every session, and email the target a
 *                      single-use reset link (`/admin/reset-password`).
 *   The acting admin never learns or sets the new credential.
 *
 * AUTHORISATION (all enforced here, server-side)
 *   - Route: adminAuth + permission('iam.admins', 'configure') + a fresh
 *     step-up (`requireAdminStepUp`).
 *   - Service: the actor must be an active `super` admin and must not be the
 *     target ("never their own": an admin manages their own credentials
 *     through the self-service flows). Denials emit
 *     `ADMIN_CREDENTIAL_RESET_DENIED`.
 *   - Target must have accepted its invitation (a `pending` admin has no
 *     credentials yet: resend the invitation instead). A password reset
 *     needs an `active` target, because reset links only work for active
 *     accounts.
 *
 * AUDIT
 *   `MFA_RESET_BY_ADMIN` / `PASSWORD_RESET_BY_ADMIN` security events carry
 *   the acting admin, the target and the mandatory reason.
 */

import ApiError from '../utils/ApiError.js';
import { createChildLogger } from '../utils/logger.js';
import adminRepository from '../repositories/admin.repository.js';
import sessionService from '../modules/iam/auth/session.service.js';
import mfaService from '../modules/iam/auth/mfa.service.js';
import passwordService from '../modules/iam/auth/password.service.js';
import { securityEvent } from './securityEvent.service.js';
import { stripSecrets } from './admin.service.js';

const logger = createChildLogger({ module: 'services/admin_credentials' });

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Throw 403 unless `by` (an active super admin) may reset `targetId`'s
 * credentials; returns the target admin document.
 */
async function authorize({ by, targetId, kind, reason }) {
  const deny = async (message, why) => {
    await securityEvent('ADMIN_CREDENTIAL_RESET_DENIED', {
      actor: by && OBJECT_ID_RE.test(String(by)) ? { type: 'admin', id: String(by) } : { type: 'system', id: null },
      reason: reason ?? undefined,
      metadata: { targetAdminId: String(targetId), kind, why },
    });
    return ApiError.forbidden(message);
  };
  if (!by || !OBJECT_ID_RE.test(String(by))) throw await deny('Only an active super administrator can reset credentials', 'no_actor');
  if (String(by) === String(targetId)) {
    throw await deny('You cannot reset your own credentials here; use your account security settings', 'self');
  }
  const actor = await adminRepository.findById(by);
  if (!actor || actor.status !== 'active' || actor.adminType !== 'super') {
    throw await deny('Only an active super administrator can reset credentials', 'not_super');
  }
  const target = await adminRepository.findById(targetId);
  if (!target) throw ApiError.notFound('Admin not found');
  if (target.status === 'pending') {
    throw ApiError.conflict('This admin has not accepted their invitation yet; resend the invitation instead');
  }
  return target;
}

/**
 * Admin-assisted MFA reset.
 *
 * @param {Object} params
 * @param {string} params.adminId - the admin being reset.
 * @param {string} params.by - acting admin id.
 * @param {string} params.reason - why (stored with the security event).
 * @returns {Promise<{ admin: Object, sessionsRevoked: number, mfaEnrollmentRequired: true }>}
 */
export async function resetMfa({ adminId, by, reason }) {
  await authorize({ by, targetId: adminId, kind: 'mfa', reason });
  const updated = await mfaService.resetByAdmin({ adminId, by });
  const sessionsRevoked = await sessionService.revokeAllForActor({ actorId: String(adminId), reason: 'mfa_reset_by_admin' });
  await securityEvent('MFA_RESET_BY_ADMIN', {
    actor: { type: 'admin', id: String(by) },
    reason,
    metadata: { targetAdminId: String(adminId), sessionsRevoked },
  });
  logger.warn({ adminId: String(adminId), by: String(by) }, 'admin MFA reset by another administrator');
  return { admin: stripSecrets(updated), sessionsRevoked, mfaEnrollmentRequired: true };
}

/**
 * Admin-assisted password reset: the old password is voided immediately and
 * the target receives a single-use reset link by email.
 *
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.by
 * @param {string} params.reason
 * @returns {Promise<{ admin: Object, sessionsRevoked: number, delivered: boolean, resetLinkExpiresAt: Date }>}
 */
export async function resetPassword({ adminId, by, reason }) {
  const target = await authorize({ by, targetId: adminId, kind: 'password', reason });
  if (target.status !== 'active') {
    throw ApiError.conflict('Only an active admin can receive a password reset link; restore the admin first');
  }
  const updated = await adminRepository.update(
    adminId,
    { passwordHash: null, failedAttempts: 0, lockedUntil: null },
    { by },
  );
  if (!updated) throw ApiError.notFound('Admin not found');
  const sessionsRevoked = await sessionService.revokeAllForActor({ actorId: String(adminId), reason: 'password_reset_by_admin' });
  const { delivered, expiresAt } = await passwordService.issueAdminAssistedReset({ account: updated });
  await securityEvent('PASSWORD_RESET_BY_ADMIN', {
    actor: { type: 'admin', id: String(by) },
    reason,
    metadata: { targetAdminId: String(adminId), sessionsRevoked, delivered },
  });
  logger.warn({ adminId: String(adminId), by: String(by), delivered }, 'admin password reset by another administrator');
  return { admin: stripSecrets(updated), sessionsRevoked, delivered, resetLinkExpiresAt: expiresAt };
}

export default { resetMfa, resetPassword };
