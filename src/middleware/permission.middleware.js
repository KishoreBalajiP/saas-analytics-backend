/**
 * permission.middleware.js (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Fine-grained RBAC. Checks that the actor holds the (module, action)
 *   permission the route declares, using the cached actor permission set
 *   from `services/permission.service#resolveActorPermissions`.
 *
 * STATIC MODE
 *   ```
 *   router.get('/dashboards/:id',
 *     permission('analytics', 'view'),
 *     dashboardController.getById);
 *   ```
 *
 * DYNAMIC MODE
 *   The module/action can also be a function so per-resource checks
 *   (e.g. tenant-scoped permission on the requested tenant) work:
 *   ```
 *   router.get('/tenants/:tenantId/users',
 *     permission(req => ['tenants', 'view']),
 *     userController.list);
 *   ```
 *
 * RESPONSIBILITY
 *   - Read declared (module, action) for the route.
 *   - Resolve the actor's effective permissions (cached 60s).
 *   - Refuse 403 on absence.
 *
 * SECURITY RULES
 *   - Fail closed: no identity and no declared key both yield 403, never a
 *     pass-through.
 *   - Runs AFTER `adminAuth` / `auth` (needs `req.admin` or `req.user`).
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';
import permissionService from '../services/permission.service.js';

/** Resolve a (module, action) pair that may be a function of the request. */
function resolveKey(req, moduleOrFn, actionOrFn) {
  if (typeof moduleOrFn === 'function') {
    const pair = moduleOrFn(req);
    return { module: pair?.[0] ?? null, action: pair?.[1] ?? null };
  }
  return { module: moduleOrFn, action: actionOrFn };
}

/** Load the actor's effective permission keys, failing closed without an actor. */
async function resolveActorPerms(req, next) {
  const actor = getActor(req);
  if (!actor) {
    next(ApiError.forbidden('Authenticated identity is required'));
    return null;
  }
  try {
    const keys = await permissionService.resolveActorPermissions({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: actor.tenantId,
    });
    return new Set(keys);
  } catch (err) {
    next(err);
    return null;
  }
}

/**
 * Permission factory. Accepts either:
 *   - `permission('analytics', 'view')`
 *   - `permission(req => ['analytics', 'view'])`
 * Refuses 403 when the actor lacks the declared `<module>.<action>` key.
 *
 * @param {string|(req) => [string, string]} moduleOrFn
 * @param {string} [actionOrFn]
 * @returns {import('express').RequestHandler}
 */
export function permission(moduleOrFn, actionOrFn) {
  return async (req, _res, next) => {
    const { module, action } = resolveKey(req, moduleOrFn, actionOrFn);
    if (!module || !action) {
      return next(ApiError.forbidden('Route did not declare a permission key'));
    }

    const perms = await resolveActorPerms(req, next);
    if (!perms) return undefined;
    if (!perms.has(`${module}.${action}`)) {
      return next(ApiError.forbidden(`You do not have the "${module}.${action}" permission`));
    }
    return next();
  };
}

/**
 * Inverse helper: deny list. Refuses 403 when the actor DOES hold the
 * declared permission (e.g. block a "suspend" action for a group that is
 * only allowed to view).
 *
 * @param {string|(req) => [string, string]} moduleOrFn
 * @param {string} [actionOrFn]
 * @returns {import('express').RequestHandler}
 */
export function denyIf(moduleOrFn, actionOrFn) {
  return async (req, _res, next) => {
    const { module, action } = resolveKey(req, moduleOrFn, actionOrFn);
    if (!module || !action) return next();

    const perms = await resolveActorPerms(req, next);
    if (!perms) return undefined;
    if (perms.has(`${module}.${action}`)) {
      return next(ApiError.forbidden(`You are not allowed to use "${module}.${action}"`));
    }
    return next();
  };
}

export default {
  permission,
  denyIf,
  _meta: {
    phase: '2 - implemented',
    runOrder: 'after rbac / modulePermission',
    resolves: 'services/permission.service#resolveActorPermissions',
  },
};
