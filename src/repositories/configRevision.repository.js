/**
 * ConfigRevision Repository (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Data access for the append-only configuration history
 *   (`models/ConfigRevision.js`). No business logic: the owning services
 *   decide what a revision contains and who may read it.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - `insert` relies on the unique `{ kind, resourceKey, version }` index;
 *     a duplicate means a concurrent writer recorded the same version and is
 *     surfaced to the caller (code 11000) instead of being swallowed.
 */

import { ConfigRevision } from '../models/ConfigRevision.js';

/** Append one revision. Returns the saved plain document. */
export const insert = async (data) => {
  const doc = new ConfigRevision(data);
  await doc.save();
  return doc.toObject();
};

/** Paginated history for one resource, newest first. */
export const list = async ({ kind, resourceKey, page = 1, limit = 20 }) => {
  const result = await ConfigRevision.paginate(
    { kind, resourceKey },
    { page, limit, lean: true, sort: { version: -1 } },
  );
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** One revision by version, or null. */
export const findVersion = ({ kind, resourceKey, version }) =>
  ConfigRevision.findOne({ kind, resourceKey, version }).lean();

/** The newest revision for a resource, or null. */
export const findLatest = ({ kind, resourceKey }) =>
  ConfigRevision.findOne({ kind, resourceKey }).sort({ version: -1 }).lean();

export default { insert, list, findVersion, findLatest };
