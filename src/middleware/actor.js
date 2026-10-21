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
 * @returns {{ id: string, type: 'admin'|'user', tenantId: string|null, email: string|null, impersonatedBy?: string } | null}
 *   `impersonatedBy` (support, roadmap 2.3) is the operator admin id when a
 *   tenant user's request comes from a read-only support session.
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
    const actor = {
      id: req.user.id,
      type: 'user',
      tenantId: req.user.tenantId ?? null,
      email: req.user.email ?? null,
    };
    // support: operator attribution for support sessions.
    if (req.user.impersonatedBy) actor.impersonatedBy = req.user.impersonatedBy;
    return actor;
  }
  return null;
}

export default { getActor };
