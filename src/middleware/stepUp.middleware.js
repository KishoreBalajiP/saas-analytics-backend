/**
 * Step-up guard for sensitive admin routes (roadmap 2.2, adminauth).
 *
 * WHY IT EXISTS
 *   A valid admin access token proves a sign-in, possibly hours ago (or a
 *   stolen token). Granting super, resetting another admin's credentials,
 *   reading secret settings and regenerating recovery codes additionally
 *   require a recent re-authentication: `POST /admin-auth/step-up` with the
 *   password and a current code stamps the session, and this guard admits
 *   requests on that session for `ADMIN_STEP_UP_TTL_MS`.
 *
 * USAGE (after adminAuth + permission + validate)
 *   router.post('/admins/:id/mfa/reset', adminAuth, permission('iam.admins', 'configure'),
 *     validate(schema), requireAdminStepUp(), handler);
 *   // conditional: only when the request is sensitive
 *   requireAdminStepUp({ when: stepUpWhen.grantsSuperType })
 *
 * CONTRACT
 *   - 403 `STEP_UP_REQUIRED` when no fresh step-up exists on the caller's
 *     session (the client opens its re-authentication dialog and retries).
 *   - The step-up time comes from the session document read by
 *     `adminAuth` (`req.admin.stepUpAt`), never from the request.
 *   - `when(req)` may be async; a throw fails the request (fail closed).
 */

import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import { isStepUpFresh } from '../modules/iam/auth/stepUp.service.js';
// mfa-tenant: tenant-user step-up window.
import { isUserStepUpFresh } from '../modules/iam/auth/tenantMfa.service.js';
import roleService from '../services/role.service.js';
import { PLATFORM_ROLE_NAMES } from '../constants/platformRoles.js';

/** The admin type that grants full control. */
const SUPER = 'super';
/** Platform roles that grant full control: the built-in super role and the legacy `super` role. */
const SUPER_ROLE_NAMES = new Set([PLATFORM_ROLE_NAMES.SUPER, 'super']);

/** 403 telling the client to re-authenticate and retry. */
export function stepUpRequiredError() {
  const err = ApiError.forbidden('Confirm your password and authenticator code to continue');
  err.code = ERROR_CODES.STEP_UP_REQUIRED;
  return err;
}

/**
 * @param {Object} [options]
 * @param {(req: import('express').Request) => boolean|Promise<boolean>} [options.when]
 *   - apply the guard only when this returns true.
 * @returns {import('express').RequestHandler}
 */
export function requireAdminStepUp({ when } = {}) {
  return async (req, _res, next) => {
    try {
      if (when && !(await when(req))) return next();
      if (!req.admin?.id) return next(ApiError.unauthorized('Authentication required'));
      if (isStepUpFresh(req.admin.stepUpAt ?? null)) return next();
      return next(stepUpRequiredError());
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * mfa-tenant: step-up guard for sensitive TENANT routes (after
 * `authenticate`): Owner-assisted MFA reset, regenerating recovery codes.
 * `POST /auth/step-up` stamps the session; the time comes from the session
 * document read by `authenticate` (`req.user.stepUpAt`), never the request.
 * 403 `STEP_UP_REQUIRED` otherwise.
 *
 * @returns {import('express').RequestHandler}
 */
export function requireUserStepUp() {
  return (req, _res, next) => {
    if (!req.user?.id) return next(ApiError.unauthorized('Authentication required'));
    if (isUserStepUpFresh(req.user.stepUpAt ?? null)) return next();
    return next(stepUpRequiredError());
  };
}

/**
 * Sensitive-request predicates for `requireAdminStepUp({ when })`.
 * They read only VALIDATED input (`req.validated`), after `validate()`.
 */
export const stepUpWhen = Object.freeze({
  /** Creating/inviting or updating an admin to the `super` type. */
  grantsSuperType: (req) => String(req.validated?.body?.adminType ?? '').toLowerCase() === SUPER,
  /**
   * Granting a super role (`super_admin`, or the legacy `super`; any scope;
   * case-insensitive). An unknown
   * role is not sensitive here (the handler answers 404); any other lookup
   * failure propagates (fail closed).
   */
  grantsSuperRole: async (req) => {
    const roleId = req.validated?.body?.roleId;
    if (!roleId) return false;
    try {
      const role = await roleService.getById({ id: roleId });
      return SUPER_ROLE_NAMES.has(String(role?.name ?? '').toLowerCase());
    } catch (err) {
      if (err?.statusCode === 404) return false;
      throw err;
    }
  },
  /** Reading secret settings in plaintext (`?includeSecrets=true`). */
  readsSecrets: (req) => ['true', '1', true].includes(req.query?.includeSecrets ?? req.validated?.query?.includeSecrets),
});

export default { requireAdminStepUp, stepUpRequiredError, stepUpWhen, requireUserStepUp };
