/**
 * User Validators (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/users` surface, consumed by
 *   `validate(schema)` from `src/validators/index.js`.
 *
 * RESPONSIBILITY
 *   - updateMeSchema   { name?, locale?, timezone?, avatarUrl?, phone? }
 *   - listSchema       { search?, page?, limit? }
 *
 * CODING GUIDELINES
 *   - The tenant is NEVER accepted in the body/query/params - it is always
 *     derived from the authenticated token by the controller/service.
 *   - Profile fields mirror `models/User.js#profile`.
 */

/** @type {import('../index.js').Schema} */
export const updateMeSchema = {
  body: {
    name: { type: 'string', maxLength: 80 },
    locale: { type: 'string', minLength: 2, maxLength: 16 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    avatarUrl: { type: 'url' },
    phone: { type: 'string', maxLength: 32 },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const listSchema = {
  body: {},
  params: {},
  query: {
    search: { type: 'string', maxLength: 128 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export default {
  updateMeSchema,
  listSchema,
  _meta: { phase: '2 - implemented', tenancy: 'token-derived' },
};
