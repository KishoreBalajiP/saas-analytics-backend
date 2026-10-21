/**
 * Tenant-user MFA policy (roadmap 4.E1, mfa-tenant).
 *
 * PURPOSE
 *   Decides whether a tenant user MUST use MFA. A user who must, but signs
 *   in without MFA, gets a session restricted to MFA enrolment
 *   (`Session.restriction = 'mfa_enrollment'`, the same mechanism the admin
 *   portal uses); every other tenant route refuses that session with 403
 *   `MFA_ENROLLMENT_REQUIRED` until enrolment completes.
 *
 * RULE
 *   MFA is required when either holds:
 *   - the workspace policy `security.mfa_required` is on (set by the Owner
 *     at `PATCH /workspace/security`, or by a platform admin through the
 *     tenant settings surface);
 *   - an Owner-assisted MFA reset flagged the account
 *     (`mfaEnrollmentRequired`).
 *
 * NOTES
 *   - The policy read fails CLOSED: a lookup error propagates, so a login
 *     or refresh that cannot evaluate it fails rather than skipping MFA.
 *   - The setting is cached for 60 s per instance (`setting.service`); a
 *     write through this app invalidates the entry at once.
 */

import * as tenantSettings from '../../../services/tenantSettings.service.js';

/**
 * Whether the workspace requires MFA for every member.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
export async function isWorkspaceMfaRequired(tenantId) {
  if (!tenantId) return false;
  return tenantSettings.getMfaRequired(String(tenantId));
}

/**
 * Whether this tenant user must use MFA.
 *
 * @param {Object|null} user - lean user (needs `tenantId`, `mfaEnrollmentRequired`).
 * @returns {Promise<boolean>}
 */
export async function isMfaRequired(user) {
  if (!user) return false;
  if (user.mfaEnrollmentRequired) return true;
  return isWorkspaceMfaRequired(user.tenantId);
}

export default { isMfaRequired, isWorkspaceMfaRequired };
