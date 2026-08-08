/**
 * modulePermission.middleware.js (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Coarse-grained module visibility check. Useful for menu rendering and
 *   for routes that accept any action on a module (a wildcard) rather than
 *   a single (module, action).
 *
 * RESPONSIBILITY
 *   - Verify the actor has AT LEAST ONE permission whose key starts with
 *     `<module>.` (e.g. any `platform.*` key for module `platform`).
 *   - Refuse 403 when the actor has none.
 *
 * USAGE
 *   ```
 *   router.use(modulePermission('platform'));
 *   ```
 *
 * SECURITY RULES
 *   - Fail closed: no identity, or no permission on the module, yields 403.
 *   - Runs AFTER `adminAuth` / `auth`.
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';
import permissionService from '../services/permission.service.js';

/**
 * Require the actor to hold at least one permission on `moduleKey`.
 *
 * @param {string} moduleKey - module key, e.g. `'platform'`.
 * @returns {import('express').RequestHandler}
 */
export function modulePermission(moduleKey) {
  return async (req, _res, next) => {
    const key = String(moduleKey ?? '').trim().toLowerCase();
    if (!key) return next(ApiError.forbidden('Route did not declare a module key'));

    const actor = getActor(req);
    if (!actor) return next(ApiError.forbidden('Authenticated identity is required'));

    let keys;
    try {
      keys = await permissionService.resolveActorPermissions({
        actorType: actor.type,
        actorId: actor.id,
        tenantId: actor.tenantId,
      });
    } catch (err) {
      return next(err);
    }

    const prefix = `${key}.`;
    if (!keys.some((k) => k.startsWith(prefix))) {
      return next(ApiError.forbidden(`You do not have access to the "${key}" module`));
    }
    return next();
  };
}

export default {
  modulePermission,
  _meta: {
    phase: '2 - implemented',
    relationship: 'composes with permission.middleware for fine-grained checks',
  },
};
