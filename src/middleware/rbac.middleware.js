/**
 * rbac.middleware.js (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Coarse-grained role-based access control. Verifies that the caller has
 *   AT LEAST ONE role (or one of a specific role set). Runs AFTER
 *   `adminAuth` (or tenant `auth`) - it relies on `req.admin` / `req.user`.
 *
 * RESPONSIBILITY
 *   - `requireRole(...)`   - resolve the actor's role names via the cached
 *     RBAC role set (`services/role.service#resolveActorRoles`); refuse 403
 *     when the intersection is empty. Called with no arguments it simply
 *     requires the actor to hold ANY role.
 *   - `requireAdminType(...)` - coarse gate for platform administration
 *     (`super` | `platform` | `support`). Admin type is not embedded in the
 *     access token, so the current admin row is read (lean) to check it.
 *
 * SECURITY RULES
 *   - Fail closed: missing identity, unknown admin, or an empty role
 *     intersection all yield 403.
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';
import roleService from '../services/role.service.js';
import adminRepository from '../repositories/admin.repository.js';

/**
 * Require the actor to hold ANY role, or at least one of `allowedRoles`.
 *
 * @param {...string} allowedRoles - empty means "any role at all".
 * @returns {import('express').RequestHandler}
 */
export function requireRole(...allowedRoles) {
  return async (req, _res, next) => {
    const actor = getActor(req);
    if (!actor) return next(ApiError.forbidden('Authenticated identity is required'));

    let roles;
    try {
      roles = await roleService.resolveActorRoles({
        actorType: actor.type,
        actorId: actor.id,
        tenantId: actor.tenantId,
      });
    } catch (err) {
      return next(err);
    }

    if (roles.length === 0) {
      return next(ApiError.forbidden('You do not have a role assigned to this identity'));
    }
    if (allowedRoles.length > 0 && !allowedRoles.some((r) => roles.includes(r))) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }
    return next();
  };
}

/**
 * Require the current admin row to carry one of `allowedAdminTypes`
 * (`super` | `platform` | `support`). Only valid after `adminAuth`.
 *
 * @param {...string} allowedAdminTypes
 * @returns {import('express').RequestHandler}
 */
export function requireAdminType(...allowedAdminTypes) {
  return async (req, _res, next) => {
    const actor = getActor(req);
    if (!actor || actor.type !== 'admin') {
      return next(ApiError.forbidden('Platform admin identity is required'));
    }

    let admin;
    try {
      admin = await adminRepository.findById(actor.id);
    } catch (err) {
      return next(err);
    }
    if (!admin) return next(ApiError.forbidden('Admin account not found'));
    if (!allowedAdminTypes.includes(admin.adminType)) {
      return next(ApiError.forbidden('Your admin type does not allow this action'));
    }
    return next();
  };
}

export default {
  requireRole,
  requireAdminType,
  _meta: {
    phase: '2 - implemented',
    runOrder: 'after adminAuth / auth, before permission / modulePermission',
  },
};
