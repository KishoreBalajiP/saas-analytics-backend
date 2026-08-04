/**
 * Role Validators (architecture placeholder).
 *
 * PURPOSE
 *   Declarative schemas for the `/roles` surface.
 *
 * RESPONSIBILITY (planned, NO validation logic yet)
 *   - createRoleSchema       { name, description?, level, permissionIds[] }
 *   - updateRoleSchema       { name?, description? }
 *   - addPermissionSchema    { permissionIds[] }
 *
 * PHASE 1.2 STATUS
 *   Empty schemas; engine accepts any payload. Wire real rules in
 *   Phase 2 alongside the role service.
 */

/** @type {import('../index.js').Schema} */
export const createRoleSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const updateRoleSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const addPermissionSchema = { body: {}, params: {}, query: {} };

export default {
  createRoleSchema,
  updateRoleSchema,
  addPermissionSchema,
  _meta: { phase: '1.2 - placeholder schemas' },
};
