/**
 * Mongoose plugin: appendOnly (roadmap 2.5; finding gov.13).
 *
 * WHY IT EXISTS
 *   Trails that claim to be append-only (access logs, login attempts) had no
 *   guard at all: any update or delete query went through. This plugin
 *   rejects every update/replace/delete family on the model (query and
 *   document forms, and `bulkWrite`) unless the caller passes the explicit
 *   bypass option, which only the retention purge does.
 *
 *   It is an application-level guard. Database-level immutability needs an
 *   insert-only MongoDB user for these collections (see `models/AuditLog.js`).
 *
 * USAGE
 *   ```js
 *   schema.plugin(appendOnly, { name: 'AccessLog' });
 *   Model.deleteMany(filter).setOptions({ bypassAppendOnly: true }); // retention only
 *   ```
 */

const QUERY_OPS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
];

export const BYPASS_OPTION = 'bypassAppendOnly';

/**
 * @param {import('mongoose').Schema} schema
 * @param {{ name?: string }} [options]
 */
export function appendOnly(schema, { name = 'collection' } = {}) {
  const refusal = () => Object.assign(new Error(`${name} is append-only; use the retention purge path`), {
    code: 'APPEND_ONLY',
  });

  for (const op of QUERY_OPS) {
    schema.pre(op, { document: false, query: true }, function rejectQueryMutation() {
      const options = this.getOptions ? this.getOptions() : {};
      if (options[BYPASS_OPTION] === true) return;
      throw refusal();
    });
  }
  schema.pre('deleteOne', { document: true, query: false }, function rejectDocDelete() {
    throw refusal();
  });
  schema.pre('updateOne', { document: true, query: false }, function rejectDocUpdate() {
    throw refusal();
  });
  schema.pre('save', function rejectResave(next) {
    if (!this.isNew) return next(refusal());
    return next();
  });
  schema.pre('bulkWrite', function rejectBulkWrite(next, ops) {
    const writes = Array.isArray(ops) ? ops : [];
    if (writes.every((op) => op && Object.keys(op).length === 1 && op.insertOne)) return next();
    return next(refusal());
  });
}

export default appendOnly;
