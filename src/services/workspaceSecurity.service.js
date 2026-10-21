/**
 * Workspace Security Service (roadmap 4.E1, mfa-tenant).
 *
 * PURPOSE
 *   The Owner-facing security controls of a workspace:
 *   - the "MFA required" policy (`security.mfa_required` tenant setting):
 *     when on, every member without MFA signs in to a session restricted to
 *     MFA enrolment (`modules/iam/auth/tenantMfaPolicy.js`);
 *   - the MFA status of every member;
 *   - Owner-assisted MFA reset of a member who lost their authenticator.
 *
 * RESPONSIBILITY
 *   - getPolicy({ tenantId })
 *   - setPolicy({ tenantId, actorId, mfaRequired })
 *   - listMembers({ tenantId })
 *   - resetMemberMfa({ tenantId, actorId, userId, reason })
 *
 * AUTHORISATION (route + service)
 *   - Routes: `authenticate` + `resolveTenant` + `permission('security',
 *     'view'|'configure')`; the reset also needs a fresh tenant step-up
 *     (`requireUserStepUp`). `security.configure` is an Owner-only key in
 *     the default roles.
 *   - Turning the policy ON needs MFA on the actor's own account (409
 *     `MFA_NOT_ENABLED`), so an Owner cannot lock themselves into an
 *     enrolment-only session by accident.
 *   - Reset: never oneself (members manage their own MFA in their security
 *     settings), only a member of the same workspace (404 otherwise), and
 *     only a member whose permissions are a subset of the actor's (a
 *     custom role holding `security.configure` cannot reset an Owner).
 *     Denials emit `USER_MFA_RESET_DENIED`.
 *   - A reset wipes the secret and recovery codes, revokes every session of
 *     the member and requires enrolment at their next sign-in, whatever the
 *     policy. The actor never learns or sets the member's credentials.
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import { createChildLogger } from '../utils/logger.js';
import userRepository from '../repositories/user.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import permissionService from './permission.service.js';
import * as tenantSettings from './tenantSettings.service.js';
import { securityEvent } from './securityEvent.service.js';

const logger = createChildLogger({ module: 'services/workspace_security' });
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** Public MFA status of a member (no secret, no digest). */
function memberStatus(user) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.profile?.name ?? '',
    status: user.status,
    mfaEnabled: Boolean(user.mfaEnabled),
    mfaEnrollmentRequired: Boolean(user.mfaEnrollmentRequired),
    recoveryCodesGeneratedAt: user.mfaEnabled ? user.mfaRecoveryCodesGeneratedAt ?? null : null,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

/**
 * The workspace security policy.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @returns {Promise<{ mfaRequired: boolean, members: { total: number, mfaEnabled: number } }>}
 */
export async function getPolicy({ tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const [mfaRequired, members] = await Promise.all([
    tenantSettings.getMfaRequired(tenantId),
    userRepository.listMfaStatus(String(tenantId)),
  ]);
  return {
    mfaRequired,
    members: { total: members.length, mfaEnabled: members.filter((m) => m.mfaEnabled).length },
  };
}

/**
 * Change the workspace MFA policy.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.actorId
 * @param {boolean} params.mfaRequired
 * @returns {Promise<Object>} the policy after the change.
 */
export async function setPolicy({ tenantId, actorId, mfaRequired } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (typeof mfaRequired !== 'boolean') {
    throw ApiError.badRequest('Invalid security policy', [{ field: 'mfaRequired', message: 'must be true or false' }]);
  }
  const before = await tenantSettings.getMfaRequired(tenantId);
  if (mfaRequired && !before) {
    const actor = actorId ? await userRepository.findMfaState(actorId, tenantId) : null;
    if (!actor?.mfaEnabled) {
      const err = ApiError.conflict('Turn on multi-factor authentication for your own account before requiring it for the workspace');
      err.code = ERROR_CODES.MFA_NOT_ENABLED;
      throw err;
    }
  }
  if (mfaRequired !== before) {
    await tenantSettings.setMfaRequired({ tenantId, required: mfaRequired, by: actorId ?? null });
    logger.info({ tenantId: String(tenantId), mfaRequired }, 'workspace mfa policy changed');
    await securityEvent('WORKSPACE_MFA_POLICY_CHANGED', {
      actor: actorId ? { type: 'user', id: String(actorId) } : undefined,
      tenantId: String(tenantId),
      resource: { type: 'tenant_setting', id: tenantSettings.MFA_REQUIRED_SETTING_KEY },
      metadata: { before, after: mfaRequired },
    });
  }
  return getPolicy({ tenantId });
}

/**
 * MFA status of every member of the workspace.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @returns {Promise<Object[]>}
 */
export async function listMembers({ tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const users = await userRepository.listMfaStatus(String(tenantId));
  return users.map(memberStatus);
}

/**
 * Owner-assisted MFA reset of a member.
 *
 * @param {Object} params
 * @param {string} params.tenantId - the workspace (from the resolved request).
 * @param {string} params.actorId - the acting member (from the token).
 * @param {string} params.userId - the member being reset.
 * @param {string} params.reason - why (stored with the security event).
 * @returns {Promise<{ member: Object, sessionsRevoked: number, mfaEnrollmentRequired: true }>}
 */
export async function resetMemberMfa({ tenantId, actorId, userId, reason } = {}) {
  if (!tenantId || !actorId) throw ApiError.badRequest('tenantId and actor are required');
  const deny = async (message, why) => {
    await securityEvent('USER_MFA_RESET_DENIED', {
      actor: { type: 'user', id: String(actorId) },
      tenantId: String(tenantId),
      resource: { type: 'user', id: String(userId) },
      reason: reason ?? undefined,
      metadata: { why, targetUserId: String(userId) },
    });
    return ApiError.forbidden(message);
  };
  if (String(actorId) === String(userId)) {
    throw await deny('You cannot reset your own MFA here; use your security settings', 'self');
  }
  if (!OBJECT_ID_RE.test(String(userId ?? ''))) throw ApiError.notFound('Member not found');
  const target = await userRepository.findMfaState(userId, tenantId);
  if (!target) throw ApiError.notFound('Member not found');

  // Role ceiling: the member's permissions must all be held by the actor.
  const [actorPermissions, targetPermissions] = await Promise.all([
    permissionService.resolveActorPermissions({ actorType: 'user', actorId: String(actorId), tenantId: String(tenantId) }),
    permissionService.resolveActorPermissions({ actorType: 'user', actorId: String(userId), tenantId: String(tenantId) }),
  ]);
  const held = new Set(actorPermissions);
  if (targetPermissions.some((key) => !held.has(key))) {
    throw await deny('You cannot reset MFA for a member who holds permissions you do not hold', 'ceiling');
  }

  const updated = await userRepository.resetMfa(userId, String(tenantId), { by: String(actorId) });
  if (!updated) throw ApiError.notFound('Member not found');
  const sessionsRevoked = await sessionRepository.revokeAllForActor(String(userId), 'mfa_reset_by_owner');
  await securityEvent('USER_MFA_RESET_BY_OWNER', {
    actor: { type: 'user', id: String(actorId) },
    tenantId: String(tenantId),
    resource: { type: 'user', id: String(userId) },
    reason,
    metadata: { targetUserId: String(userId), sessionsRevoked, hadMfa: Boolean(target.mfaEnabled) },
  });
  logger.warn({ tenantId: String(tenantId), userId: String(userId), by: String(actorId) }, 'member mfa reset by workspace owner');
  return { member: memberStatus(updated), sessionsRevoked, mfaEnrollmentRequired: true };
}

export default { getPolicy, setPolicy, listMembers, resetMemberMfa };
