/**
 * Notification Validator (Sprint 7 - implemented).
 *
 * Exports `validate()`-compatible SCHEMA OBJECTS consumed by
 * `src/routes/notification.routes.js`.
 */

export const listSchema = {
  query: {
    page: 'integer',
    limit: 'integer',
    unreadOnly: 'boolean',
  },
};

export const idSchema = {
  params: { id: 'objectId|required' },
};

export const preferencesSchema = {
  body: { preferences: 'object' },
};

export default { listSchema, idSchema, preferencesSchema };
