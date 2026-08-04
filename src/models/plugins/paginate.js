/**
 * Mongoose plugin: paginate.
 *
 * WHY IT EXISTS
 *   Every list endpoint needs the same pagination shape
 *   (`{ docs, total, page, limit, pages }`). Wrapping
 *   `mongoose-paginate-v2` here gives every model a uniform API and a
 *   single place to enforce defaults from `config/constants.js`.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(paginate);
 *
 *   const result = await Model.paginate(
 *     { tenantId: 't_01H...' },
 *     { page: 1, limit: 20, sort: { createdAt: -1 } },
 *   );
 *   ```
 *
 * BEHAVIOUR
 *   - Caps `limit` at `PAGINATION.maxLimit`.
 *   - Forces a default sort by `createdAt: -1` when none is provided.
 *
 * HOW TO EXTEND
 *   - Override defaults by passing `pagination` on the schema options.
 */

import mongoosePaginate from 'mongoose-paginate-v2';
import { PAGINATION } from '../../config/constants.js';

const DEFAULT_OPTIONS = Object.freeze({
  defaultLimit: PAGINATION.defaultLimit,
  maxLimit: PAGINATION.maxLimit,
  defaultSort: '-createdAt',
});

/**
 * Attach the paginate plugin to a schema.
 *
 * @param {import('mongoose').Schema} schema
 * @param {Object} [options]
 */
export function paginate(schema, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  schema.plugin(mongoosePaginate, {
    limit: opts.defaultLimit,
    maxLimit: opts.maxLimit,
    sort: opts.defaultSort,
  });
}

export default paginate;
