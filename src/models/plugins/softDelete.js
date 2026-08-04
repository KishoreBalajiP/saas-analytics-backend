/**
 * Mongoose plugin: softDelete.
 *
 * WHY IT EXISTS
 *   Hard-deleting tenant-owned records is dangerous (compliance, audit,
 *   accidental data loss). The platform soft-deletes everything and lets
 *   the compliance cron hard-delete after the retention window.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ ... });
 *   schema.plugin(softDelete);
 *   ```
 *
 * API additions
 *   - `deletedAt`, `deletedBy` fields on every document.
 *   - All `find*` queries auto-filter `deletedAt: null` unless
 *     `Model.withDeleted()` is used.
 *   - `doc.softDelete(byUserId)` and `doc.restore()` instance methods.
 *   - `Model.softDeleteById(id, byUserId)` static.
 *
 * DESIGN CONSTRAINTS
 *   - The filter is applied automatically so callers cannot accidentally
 *     read deleted records. Tests opt-out with `withDeleted()`.
 *
 * HOW TO EXTEND
 *   - Add a TTL index on `deletedAt` for transient records (e.g. drafts).
 */

const DEFAULT_OPTIONS = Object.freeze({
  field: 'deletedAt',
  deletedByField: 'deletedBy',
  /** Optional retention period in seconds; a TTL index is added when set. */
  ttlSec: null,
});

/**
 * Attach the soft-delete plugin to a schema.
 *
 * @param {import('mongoose').Schema} schema
 * @param {Object} [options]
 */
export function softDelete(schema, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!schema.path(opts.field)) {
    const fieldDef = { type: Date, default: null, index: true };
    if (Number.isInteger(opts.ttlSec) && opts.ttlSec > 0) {
      fieldDef.expires = opts.ttlSec;
    }
    schema.add({ [opts.field]: fieldDef });
  }
  if (!schema.path(opts.deletedByField)) {
    schema.add({ [opts.deletedByField]: { type: String, default: null } });
  }

  // Auto-filter reads.
  const filterMiddleware = function (next) {
    const filter = this.getFilter ? this.getFilter() : (this._conditions ?? {});
    const options = this.getOptions ? this.getOptions() : {};
    if (options.includeDeleted === true) return next();
    if (filter[opts.field] === undefined) {
      filter[opts.field] = null;
      if (typeof this.setQuery === 'function') this.setQuery(filter);
      else this._conditions = filter;
    }
    next();
  };

  schema.pre('find', filterMiddleware);
  schema.pre('findOne', filterMiddleware);
  schema.pre('findOneAndUpdate', filterMiddleware);
  schema.pre('count', filterMiddleware);
  schema.pre('countDocuments', filterMiddleware);

  // Prevent hard deletes via `findOneAndDelete` / `findByIdAndDelete` from
  // accidentally removing soft-deleted records.
  schema.pre('findOneAndDelete', filterMiddleware);
  schema.pre('findOneAndRemove', filterMiddleware);

  schema.statics.withDeleted = function withDeleted() {
    // Return a query preconfigured with the bypass option. Callers can
    // chain `.find()`, `.findOne()`, etc. on the result.
    return this.find().setOptions({ includeDeleted: true });
  };

  schema.statics.onlyDeleted = function onlyDeleted() {
    return this.find({ [opts.field]: { $ne: null } });
  };

  schema.statics.softDeleteById = async function softDeleteById(id, byUserId) {
    const doc = await this.findById(id);
    if (!doc) return null;
    await doc.softDelete(byUserId);
    return doc;
  };

  schema.methods.softDelete = function softDelete(byUserId) {
    this[opts.field] = new Date();
    this[opts.deletedByField] = byUserId ?? null;
    return this.save();
  };

  schema.methods.restore = function restore() {
    this[opts.field] = null;
    this[opts.deletedByField] = null;
    return this.save();
  };

  schema.methods.isDeleted = function isDeleted() {
    return this[opts.field] !== null && this[opts.field] !== undefined;
  };
}

export default softDelete;
