/**
 * Role Validators (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/roles` surface, consumed by
 *   `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - createRoleSchema       { name, description?, tenantId? }
 *   - updateRoleSchema       { name?, description? }
 *   - addPermissionSchema    { permissionKey }
 *   - removePermissionSchema { permissionKey }
 *   - listSchema             { tenantId?, search?, page?, limit? }
 *
 * CODING GUIDELINES
 *   - `tenantId === null` means the platform scope; an omitted tenantId in
 *     the body is the same thing (the service defaults to the platform).
 *   - A permission key is always `<module_key>.<action>`; enforced here
 *     and again in the service - never trust callers.
 */

/** Dotted lowercase module key (e.g. `iam`, `iam.users`, `audit_logs`). */
const MODULE_KEY_PATTERN = '^[a-z0-9]+(?:_[a-z0-9]+)*(?:\\.[a-z0-9]+(?:_[a-z0-9]+)*)*$';

/** `<module_key>.<action>` permission key. */
const PERMISSION_KEY_PATTERN = '^[a-z0-9]+(?:_[a-z0-9]+)*(?:\\.[a-z0-9]+(?:_[a-z0-9]+)*)*\\.[a-z]+$';

const pagination = {
  page: { type: 'integer', min: 1 },
  limit: { type: 'integer', min: 1, max: 100 },
};

/** @type {import('../index.js').Schema} */
export const createRoleSchema = {
  body: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 64 },
    description: { type: 'string', maxLength: 500 },
    tenantId: { type: 'string', minLength: 1 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const updateRoleSchema = {
  body: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    description: { type: 'string', maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const addPermissionSchema = {
  body: {
    permissionKey: {
      type: 'string',
      required: true,
      pattern: PERMISSION_KEY_PATTERN,
    },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const removePermissionSchema = {
  body: {
    permissionKey: {
      type: 'string',
      required: true,
      pattern: PERMISSION_KEY_PATTERN,
    },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const listSchema = {
  body: {},
  params: {},
  query: {
    tenantId: { type: 'string', minLength: 1 },
    search: { type: 'string', maxLength: 128 },
    ...pagination,
  },
};

export default {
  createRoleSchema,
  updateRoleSchema,
  addPermissionSchema,
  removePermissionSchema,
  listSchema,
  _meta: { phase: '2 - implemented', permissionKey: 'dotted <module_key>.<action>' },
};
