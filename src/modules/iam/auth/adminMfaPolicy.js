/**
 * Admin MFA policy (roadmap 2.2, adminauth).
 *
 * PURPOSE
 *   Decides whether a platform admin MUST use MFA. A privileged admin who
 *   signs in without MFA gets a session restricted to MFA enrolment
 *   (`Session.restriction = 'mfa_enrollment'`); every other admin route
 *   refuses that session until enrolment completes.
 *
 * RULE
 *   MFA is required when any of these holds:
 *   - an admin-assisted MFA reset flagged the account
 *     (`mfaEnrollmentRequired`), whatever its type;
 *   - its `adminType` is listed in `ADMIN_MFA_REQUIRED_TYPES`
 *     (default `super,platform`; `none` disables the type rule);
 *   - it holds the built-in platform role of one of those types
 *     (`super_admin`, `platform_admin`, see constants/platformRoles.js) or a
 *     legacy pre-2.1 role of that name (`super`, `platform`), so a `support`
 *     admin granted the super role is privileged too.
 *
 * NOTES
 *   - Role resolution uses the cached RBAC role set (role.service), so the
 *     check costs no extra query on a warm cache. Lookup failures propagate
 *     (fail closed: a login that cannot evaluate the policy fails).
 *   - Platform role names come from the roles package catalogue
 *     (Super / Platform / Support / Auditor); the comparison is
 *     case-insensitive.
 */

import env from '../../../config/env.js';
import roleService from '../../../services/role.service.js';
import { ROLE_FOR_ADMIN_TYPE, LEGACY_PLATFORM_ROLE_NAMES } from '../../../constants/platformRoles.js';

const REQUIRED_TYPES = Object.freeze([...(env.security.auth.adminMfaRequiredTypes ?? [])]);
const REQUIRED = new Set(REQUIRED_TYPES);
/** Platform role names (lower-case) that make an admin privileged. */
const PRIVILEGED_ROLE_NAMES = new Set(REQUIRED_TYPES.flatMap((type) => [
  ROLE_FOR_ADMIN_TYPE[type],
  LEGACY_PLATFORM_ROLE_NAMES.includes(type) ? type : null,
]).filter(Boolean).map((name) => name.toLowerCase()));

/** Admin types (lower-case) the policy requires MFA for. */
export function requiredAdminTypes() {
  return [...REQUIRED_TYPES];
}

/**
 * Whether this admin must use MFA.
 *
 * @param {Object|null} admin - lean admin document (needs `_id`, `adminType`,
 *   `mfaEnrollmentRequired`).
 * @returns {Promise<boolean>}
 */
export async function isMfaRequired(admin) {
  if (!admin) return false;
  if (admin.mfaEnrollmentRequired) return true;
  if (REQUIRED.size === 0) return false;
  if (REQUIRED.has(String(admin.adminType ?? '').toLowerCase())) return true;
  const roles = await roleService.resolveActorRoles({
    actorType: 'admin',
    actorId: String(admin._id),
    tenantId: null,
  });
  return roles.some((name) => PRIVILEGED_ROLE_NAMES.has(String(name).toLowerCase()));
}

export default { requiredAdminTypes, isMfaRequired };
