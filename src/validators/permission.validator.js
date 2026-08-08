/**
 * Permission Validators (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/permissions` surface, consumed by
 *   `validate(schema)` from `src/validators/index.js`. Enforces the rule
 *   that every permission key is `module_key.action`.
 *
 * RESPONSIBILITY
 *   - createModuleSchema      { key, name, description? }
 *   - createPermissionSchema  { module, action }
 *   - bulkCreateSchema        { items: [{ module, action, description? }] }
 *   - listSchema              { module?, action?, page?, limit? }
 *
 * CODING GUIDELINES
 *   - The canonical action set comes from the model
 *     (`models/Permission.js#CANONICAL_ACTIONS`) so the validator and the
 *     service never drift.
 *   - The bulk `items` array is shape-checked with a custom rule (the engine
 *     has no nested-array validation).
 */

import { CANONICAL_ACTIONS } from '../models/Permission.js';

/** Dotted lowercase module key (e.g. `iam`, `iam.users`, `audit_logs`). */
const MODULE_KEY_PATTERN = '^[a-z0-9]+(?:_[a-z0-9]+)*(?:\\.[a-z0-9]+(?:_[a-z0-9]+)*)*$';

const pagination = {
  page: { type: 'integer', min: 1 },
  limit: { type: 'integer', min: 1, max: 100 },
};

/** Validate a `{ module, action, description? }` row in a bulk request. */
function checkItem(item) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return 'each item must be an object with module and action';
  }
  if (typeof item.module !== 'string' || !new RegExp(MODULE_KEY_PATTERN).test(item.module.trim().toLowerCase())) {
    return 'item.module must be a lowercase dotted module key';
  }
  if (typeof item.action !== 'string' || !CANONICAL_ACTIONS.includes(item.action.trim().toLowerCase())) {
    return `item.action must be one of: ${CANONICAL_ACTIONS.join(', ')}`;
  }
  return true;
}

/** @type {import('../index.js').Schema} */
export const createModuleSchema = {
  body: {
    key: { type: 'string', required: true, pattern: MODULE_KEY_PATTERN },
    name: { type: 'string', required: true, minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const createPermissionSchema = {
  body: {
    module: { type: 'string', required: true, pattern: MODULE_KEY_PATTERN },
    action: { type: 'string', required: true, oneOf: [...CANONICAL_ACTIONS] },
    description: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const bulkCreateSchema = {
  body: {
    items: {
      type: 'array',
      required: true,
      custom: (items) => {
        if (items.length === 0) return 'items must be a non-empty array';
        for (const item of items) {
          const result = checkItem(item);
          if (result !== true) return result;
        }
        return true;
      },
    },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const deletePermissionSchema = {
  body: {
    permissionKey: { type: 'string', required: true, pattern: MODULE_KEY_PATTERN },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const listSchema = {
  body: {},
  params: {},
  query: {
    module: { type: 'string', pattern: MODULE_KEY_PATTERN },
    action: { type: 'string', oneOf: [...CANONICAL_ACTIONS] },
    search: { type: 'string', maxLength: 128 },
    ...pagination,
  },
};

export default {
  createModuleSchema,
  createPermissionSchema,
  bulkCreateSchema,
  deletePermissionSchema,
  listSchema,
  _meta: { phase: '2 - implemented', actions: [...CANONICAL_ACTIONS] },
};
