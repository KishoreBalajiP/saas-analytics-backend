/**
 * Mongoose plugin: tenantScope.
 *
 * WHY IT EXISTS
 *   Every tenant-owned collection must filter reads and writes by
 *   `tenantId` so a coding mistake can never leak data across tenants.
 *   The plugin applies two layers of defence:
 *
 *     1. Query middleware that auto-injects the tenant filter when the
 *        caller provides `scope.tenantId` (set by the auth middleware).
 *     2. Save middleware that refuses to persist documents without a
 *        matching `tenantId`.
 *
 *   Repository code is still expected to filter explicitly; this plugin
 *   is the second line of defence, not a replacement.
 *
 * USAGE
 *   ```js
 *   const schema = new mongoose.Schema({ tenantId: String, ... });
 *   schema.plugin(tenantScope);
 *   ```
 *
 * DESIGN CONSTRAINTS
 *   - The `tenantId` field must already exist on the schema.
 *   - The active scope is read from `Model.scope.tenantId` (set by the
 *     repository / auth middleware per request via `Model.useScope()`).
 *   - When no scope is active, queries are NOT silently broadened; they
 *     run as written. The save middleware enforces the invariant.
 *
 * HOW TO EXTEND
 *   - Add `globalAdminBypass: true` option so support admins can read
 *     across tenants when they hold `tenantScope: '*'`.
 */

import mongoose from 'mongoose';

const DEFAULT_OPTIONS = Object.freeze({
  /** Field name on the schema that holds the tenant id. */
  field: 'tenantId',
  /** Field that, when truthy on the actor, lets them bypass the filter. */
  bypassField: 'tenantScope',
  /** Allow documents to be saved without tenantId when `required: false`. */
  optional: false,
});

/**
 * Attach the plugin to a schema.
 *
 * @param {import('mongoose').Schema} schema
 * @param {Object} [options]
 */
export function tenantScope(schema, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!schema.path(opts.field)) {
    // We add the field automatically so a model author cannot forget it.
    schema.add({ [opts.field]: { type: String, index: true } });
  }

  // ----- read-side enforcement -----
  const filterMiddleware = function (next) {
    const scope = this.model?.scope ?? this.$model?.scope ?? null;
    const bypass = scope?.[opts.bypassField] === '*';
    if (bypass) return next();
    if (!scope || !scope.tenantId) return next();
    const filter = this.getFilter ? this.getFilter() : (this._conditions ?? {});
    if (!filter[opts.field]) {
      filter[opts.field] = scope.tenantId;
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

  // ----- write-side enforcement -----
  schema.pre('save', function (next) {
    const value = this.get(opts.field);
    if (!value && !opts.optional) {
      return next(new Error(`tenantScope: "${opts.field}" is required on ${this.constructor.modelName}`));
    }
    next();
  });

  schema.pre('insertMany', function (next, docs) {
    if (opts.optional) return next();
    for (const doc of docs) {
      if (!doc[opts.field]) {
        return next(new Error(`tenantScope: "${opts.field}" is required on every inserted document`));
      }
    }
    next();
  });

  // ----- per-request scope -----
  schema.statics.useScope = function useScope(scope) {
    this.scope = scope;
    return this;
  };
  schema.statics.clearScope = function clearScope() {
    delete this.scope;
    return this;
  };

  // ----- convenience query helper -----
  schema.statics.withTenant = function withTenant(tenantId) {
    return this.find({ [opts.field]: tenantId });
  };
}

// Reference `mongoose` so the plugin can attach helpers even when the
// schema author forgets to import it.
void mongoose;

export default tenantScope;
