# Repositories Layer

**Data-access layer.**

Repositories isolate Mongoose/MongoDB details behind a stable API. If the
team swaps Mongo for Postgres or adds caching, only this folder changes.

```js
import Tenant from '../models/tenant.model.js';

export const findById = (id) => Tenant.findById(id).lean();
export const create = (data) => Tenant.create(data);
```

Conventions
- Repository functions return **plain objects** (`.lean()`) by default -
  controllers and services should not fight Mongoose documents.
- Keep method names behaviour-based: `findById`, `findByEmail`, `listByTenant`.
- Apply tenant scoping inside repositories (combined with the tenant
  middleware / Mongoose plugin) so data leaks are impossible by construction.
- New features: prefer `src/modules/<feature>/<feature>.repository.js`.
