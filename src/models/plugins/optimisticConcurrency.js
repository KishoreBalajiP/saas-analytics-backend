/**
 * Mongoose plugin: optimisticConcurrency.
 *
 * WHY IT EXISTS
 *   Two writers updating the same document concurrently can silently
 *   overwrite each other. Optimistic concurrency detects the race and
 *   rejects the second writer so the application can reconcile.
 *
 *   Built on top of `mongoose-update-if-current`, which uses Mongoose's
 *   internal `__v` to detect stale updates.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(optimisticConcurrency);
 *   ```
 *
 * BEHAVIOUR
 *   - `save()` and `findOneAndUpdate()` reject with `VersionError` when the
 *     stored `__v` does not match the value the writer loaded.
 *   - `updateMany`, `updateOne` and friends are NOT covered (those do not
 *     have a `__v` to compare against). Callers must use `findOneAndUpdate`
 *     or pass `{ optimisticConcurrency: true }` to opt in.
 *
 * HOW TO EXTEND
 *   - For high-contention records, add a custom `version` field via the
 *     `versionKey` option and bump it manually in a `pre('save')` hook.
 */

import { updateIfCurrentPlugin } from 'mongoose-update-if-current';

const DEFAULT_OPTIONS = Object.freeze({
  /** Strategy: 'version' (default) tracks via `__v`. */
  strategy: 'version',
  /** Mongoose plugins are stateful; apply once globally. */
  applied: false,
});

/**
 * Attach the optimistic-concurrency plugin to a schema. Built on
 * `mongoose-update-if-current#updateIfCurrentPlugin`, which uses
 * Mongoose's `__v` field to detect stale updates.
 *
 * @param {import('mongoose').Schema} schema
 * @param {Object} [options]
 */
export function optimisticConcurrency(schema, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  schema.plugin(updateIfCurrentPlugin, { strategy: opts.strategy });
}

export default optimisticConcurrency;
