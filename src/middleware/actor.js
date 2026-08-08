/**
 * actor.js - shared request-actor helper for RBAC middleware.
 *
 * PURPOSE
 *   All authorization middleware needs the same identity shape. `adminAuth`
 *   attaches `req.admin` and `authenticate` attaches `req.user`; this helper
 *   normalizes whichever one is present into the single `{ id, type,
 *   tenantId, email }` actor the RBAC services expect.
 *
 * SECURITY RULES
 *   - Returns `null` when neither identity is present (never fabricates an
 *     actor). Callers must fail closed on null.
 *   - The `tenantId` here is the actor's *home scope*: a user's tenant, or
 *     an admin's `tenantScope` claim. Cross-tenant reach is the concern of
 *     `tenantIsolation.middleware.js`, not this helper.
 */

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, type: 'admin'|'user', tenantId: string|null, email: string|null } | null}
 */
export function getActor(req) {
  if (req.admin) {
    return {
      id: req.admin.id,
      type: 'admin',
      tenantId: req.admin.tenantId ?? null,
      email: req.admin.email ?? null,
    };
  }
  if (req.user) {
    return {
      id: req.user.id,
      type: 'user',
      tenantId: req.user.tenantId ?? null,
      email: req.user.email ?? null,
    };
  }
  return null;
}

export default { getActor };
