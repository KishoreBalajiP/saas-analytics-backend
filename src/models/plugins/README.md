# Mongoose Plugins

Shared Mongoose plugins for every tenant-owned model. Apply them through
the barrel export so the import path stays stable:

```js
import plugins from '../../models/plugins/index.js';

const schema = new mongoose.Schema({ ... });
schema.plugin(plugins.tenantScope);
schema.plugin(plugins.softDelete);
schema.plugin(plugins.paginate);
schema.plugin(plugins.optimisticConcurrency);
schema.plugin(plugins.audit, { module: 'iam.users' });
```

## tenantScope

- Adds `tenantId` automatically if the schema does not declare it.
- Query middleware injects `tenantId` from the active scope
  (`Model.useScope({ tenantId })`).
- Save middleware refuses to persist a document without `tenantId`.
- Support admins bypass the filter with `Model.useScope({ tenantScope: '*' })`.

```js
Model.useScope({ tenantId: 't_01H...' });
const docs = await Model.find({});           // filtered
Model.useScope({ tenantScope: '*' });
const all = await Model.find({});            // unfiltered (support admin)
Model.clearScope();
```

## softDelete

- Adds `deletedAt` / `deletedBy` fields.
- Query middleware hides deleted records by default.
- `Model.withDeleted()` opts in for one query.
- `Model.onlyDeleted()` returns only soft-deleted records.
- `doc.softDelete(byUserId)` / `doc.restore()` instance methods.

```js
const doc = await Model.findById(id);
await doc.softDelete('usr_01H...');
const deleted = await Model.onlyDeleted();
await deleted[0].restore();
```

## paginate

- Wraps `mongoose-paginate-v2` with platform defaults
  (`PAGINATION.defaultLimit`, `PAGINATION.maxLimit`, sort `-createdAt`).

```js
const result = await Model.paginate(
  { tenantId: 't_01H...' },
  { page: 1, limit: 20 },
);
// { docs, totalDocs, limit, page, totalPages, ... }
```

## optimisticConcurrency

- Wraps `mongoose-update-if-current` (uses Mongoose's `__v`).
- `save()` and `findOneAndUpdate()` reject with `VersionError` when the
  stored version does not match.

## audit

- Adds `Model.events` (an EventEmitter) emitting `create`, `update`,
  `softDelete`, `restore`.
- Sprint 7 subscribes a consumer to persist an `AuditLog` row.

```js
Model.events.on('create', ({ doc, actor }) => auditLog.persist({ ... }));
```

## Status

Sprint 0 ships the plugins only. No business model uses them yet; CI
guard `npm run ci:check-models` flags any new model that does not import
at least one shared plugin.
