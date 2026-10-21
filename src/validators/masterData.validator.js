/**
 * Master Data Validators (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/api/v1/master-data` surface. `catalogue`
 *   selects the partition; the same catalogue string is constrained here so
 *   path traversal / stray keys never reach the repository.
 *
 * RESPONSIBILITY
 *   - listSchema       GET  /:catalogue              (page, limit, locale, search <= 64)
 *   - itemSchema       GET/DELETE /:catalogue/:id    (catalogue + id params)
 *   - catalogueSchema  POST /:catalogue/import|export (catalogue param)
 *   - createSchema     POST /:catalogue              (whitelisted body + catalogue param)
 *   - updateSchema     PATCH /:catalogue/:id         (whitelisted patch: code, name,
 *                                                     locale, data; never isSystem)
 *
 * CODING GUIDELINES
 *   - `catalogue` MUST match `/^[a-z0-9_]+$/` to keep it index-safe.
 *   - `id` MUST be a 24-hex ObjectId; the validator rejects garbage early so
 *     the repository can assume a valid id.
 */

const CATALOGUE_RE = /^[a-z0-9_]+$/;

/** Longest accepted search term (it is regex-escaped before use). */
export const MAX_SEARCH_LENGTH = 64;

const catalogueParam = { type: 'string', required: true, pattern: CATALOGUE_RE };

export const listSchema = {
  params: { catalogue: catalogueParam },
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    locale: { type: 'string', maxLength: 16 },
    search: { type: 'string', maxLength: MAX_SEARCH_LENGTH },
  },
};

export const itemSchema = {
  params: {
    catalogue: catalogueParam,
    id: { type: 'objectId', required: true },
  },
};

export const catalogueSchema = {
  params: { catalogue: catalogueParam },
};

export const createSchema = {
  params: { catalogue: catalogueParam },
  body: {
    code: { type: 'string', required: true, maxLength: 60 },
    name: { type: 'string', required: true, maxLength: 120 },
    locale: { type: 'string', maxLength: 16 },
    data: { type: 'object' },
    isSystem: { type: 'boolean' },
  },
};

export const updateSchema = {
  params: {
    catalogue: catalogueParam,
    id: { type: 'objectId', required: true },
  },
  // Whitelist: unknown keys (catalogue, isSystem, audit fields) are dropped.
  body: {
    code: { type: 'string', minLength: 1, maxLength: 60 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    locale: { type: 'string', maxLength: 16 },
    data: { type: 'object' },
  },
};

export default {
  listSchema,
  itemSchema,
  catalogueSchema,
  createSchema,
  updateSchema,
  MAX_SEARCH_LENGTH,
};
