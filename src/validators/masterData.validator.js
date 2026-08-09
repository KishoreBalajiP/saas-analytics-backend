/**
 * Master Data Validators (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/api/v1/master-data` surface. `catalogue`
 *   selects the partition; the same catalogue string is constrained here so
 *   path traversal / stray keys never reach the repository.
 *
 * RESPONSIBILITY
 *   - listSchema     GET  /:catalogue                        (page, limit, locale, search)
 *   - createSchema   POST /:catalogue                        (body + catalogue param)
 *   - updateSchema   PATCH /:catalogue/:id                   (id param; body is free-form patch)
 *
 * CODING GUIDELINES
 *   - `catalogue` MUST match `/^[a-z0-9_]+$/` to keep it index-safe.
 *   - `id` MUST be a 24-hex ObjectId; the validator rejects garbage early so
 *     the repository can assume a valid id.
 */

const CATALOGUE_RE = /^[a-z0-9_]+$/;

export const listSchema = {
  params: { catalogue: { type: 'string', required: true, pattern: CATALOGUE_RE } },
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    locale: { type: 'string' },
    search: { type: 'string' },
  },
};

export const createSchema = {
  params: { catalogue: { type: 'string', required: true, pattern: CATALOGUE_RE } },
  body: {
    code: { type: 'string', required: true, maxLength: 60 },
    name: { type: 'string', required: true, maxLength: 120 },
    locale: { type: 'string' },
    data: { type: 'object' },
    isSystem: { type: 'boolean' },
  },
};

export const updateSchema = {
  params: {
    catalogue: { type: 'string', required: true, pattern: CATALOGUE_RE },
    id: { type: 'objectId', required: true },
  },
};

export default {
  listSchema,
  createSchema,
  updateSchema,
};
