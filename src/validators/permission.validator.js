/**
 * Permission Validators (architecture placeholder).
 *
 * PURPOSE
 *   Declarative schemas for `/permissions` surface. Enforces the rule
 *   that every permission key is `module_key.action`.
 *
 * RESPONSIBILITY (planned, NO validation logic yet)
 *   - createModuleSchema      { key, name, description?, parentKey? }
 *   - createPermissionSchema  { moduleKey, action }
 *   - bulkCreateSchema        { items: [{ moduleKey, action }, ...] }
 *
 * PHASE 1.2 STATUS
 *   Empty schemas; engine accepts any payload. Replace with the real
 *   rules plus a custom rule enforcing `<module_key>.<action>` shape.
 */

/** @type {import('../index.js').Schema} */
export const createModuleSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const createPermissionSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const bulkCreateSchema = { body: {}, params: {}, query: {} };

export default {
  createModuleSchema,
  createPermissionSchema,
  bulkCreateSchema,
  _meta: { phase: '1.2 - placeholder schemas' },
};
