/**
 * Platform configuration access helpers (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Small building blocks shared by the platform configuration surfaces
 *   (`/settings`, `/feature-flags`, `/email-templates`) and the tenant
 *   settings secret gate:
 *
 *   - `requirePlatformScope` - platform configuration is GLOBAL. An admin
 *     whose token carries a tenant scope (a support admin restricted to one
 *     tenant) must not read or change it. Runs right after `adminAuth`,
 *     before the route's `permission(...)`. It is `adminScope.platform()`.
 *   - `actorHasPermission(req, key)` - a boolean check for a SECOND
 *     permission inside a handler, used where one route serves two
 *     privilege levels (e.g. a settings write that touches a secret needs
 *     `settings.secrets.update` on top of `settings.update`).
 *   - `permissionIf(predicate, module, action)` - apply a route permission
 *     only when the request asks for the privileged variant (e.g.
 *     `?includeSecrets=true` needs `settings.secrets.view`).
 *   - `requireTenantSecretWrite` - a tenant settings override that sets a
 *     secret key needs `settings.secrets.update` (roadmap 2.4, ADM:secrets).
 *
 * SECURITY RULES
 *   - Fail closed: no actor means no permission.
 *   - Uses the same cached resolver as `permission.middleware.js`, so the
 *     answer always matches what a route-level check would say.
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';
import { permission } from './permission.middleware.js';
import { adminScope } from './adminScope.middleware.js';
import permissionService from '../services/permission.service.js';
import { secretKeysIn } from '../services/tenantSettings.service.js';

/** Machine-readable code for a tenant-scoped admin reaching global config. */
export const ADMIN_SCOPE_DENIED = 'ADMIN_SCOPE_DENIED';

/**
 * Refuse 403 `ADMIN_SCOPE_DENIED` when the admin is scoped to a single
 * tenant. Platform-wide admins pass. This is the shared
 * `adminScope.platform()` guard (refusals are audited there).
 *
 * @type {import('express').RequestHandler}
 */
export const requirePlatformScope = adminScope.platform();

/**
 * Whether the request actor holds `<module>.<action>`.
 *
 * @param {import('express').Request} req
 * @param {string} key - e.g. `settings.secrets.view`.
 * @returns {Promise<boolean>}
 */
export async function actorHasPermission(req, key) {
  const actor = getActor(req);
  if (!actor?.id) return false;
  const keys = await permissionService.resolveActorPermissions({
    actorType: actor.type,
    actorId: actor.id,
    tenantId: actor.tenantId,
  });
  return keys.includes(key);
}

/** Truthy forms of a boolean query flag such as `includeSecrets`. */
export function queryFlag(req, name) {
  return ['true', '1', true].includes(req.query?.[name]);
}

/**
 * Apply `permission(module, action)` only when `predicate(req)` is true.
 *
 * @param {(req: import('express').Request) => boolean} predicate
 * @param {string} module
 * @param {string} action
 * @returns {import('express').RequestHandler}
 */
export function permissionIf(predicate, module, action) {
  const check = permission(module, action);
  return (req, res, next) => (predicate(req) ? check(req, res, next) : next());
}

/**
 * Tenant settings writes (`PATCH /tenants/:id/settings`) that set a secret
 * key need `settings.secrets.update` on top of the route permission. Runs
 * after `validate` (reads `req.validated.body`).
 *
 * @type {import('express').RequestHandler}
 */
export async function requireTenantSecretWrite(req, _res, next) {
  try {
    const { group, values } = req.validated?.body ?? req.body ?? {};
    const secretKeys = secretKeysIn(group, values);
    if (secretKeys.length && !(await actorHasPermission(req, 'settings.secrets.update'))) {
      return next(new ApiError(403, 'Changing a secret setting requires the "settings.secrets.update" permission', {
        code: 'SECRET_PERMISSION_REQUIRED',
        errors: secretKeys.map((key) => ({ field: `values.${key}`, message: 'is a secret setting' })),
      }));
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export default {
  requirePlatformScope,
  actorHasPermission,
  permissionIf,
  queryFlag,
  requireTenantSecretWrite,
  ADMIN_SCOPE_DENIED,
};
