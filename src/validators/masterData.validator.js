/**
 * Master Data Validators (architecture placeholder).
 *
 * PURPOSE
 *   Declarative schemas for the `/master-data/:catalogue` surface.
 *   `catalogue` is a path param that selects the underlying collection.
 *
 * RESPONSIBILITY (planned, NO validation logic yet)
 *   - createItemSchema    { values: json, locale? }
 *   - updateItemSchema    { patch: json, version: number }
 *
 * PHASE 1.2 STATUS
 *   Empty schemas; engine accepts any payload.
 */

/** @type {import('../index.js').Schema} */
export const createItemSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const updateItemSchema = { body: {}, params: {}, query: {} };

export default {
  createItemSchema,
  updateItemSchema,
  _meta: { phase: '1.2 - placeholder schemas' },
};
