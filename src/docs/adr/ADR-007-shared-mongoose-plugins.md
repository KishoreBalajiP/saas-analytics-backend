# ADR-007: Five Shared Mongoose Plugins

**Status:** Accepted
**Date:** 2026-08-05

## Context

Tenant-owned collections need consistent behaviour (filtering,
soft delete, pagination, optimistic concurrency, audit). Without a
shared plugin set, every model reinvents these concerns.

## Decision

Five plugins, applied via a single import path
(`src/models/plugins/index.js`):

- `tenantScope` — query + save middleware.
- `softDelete` — `deletedAt` / `deletedBy` + helpers.
- `paginate` — `mongoose-paginate-v2` wrapper.
- `optimisticConcurrency` — `mongoose-update-if-current` wrapper.
- `audit` — EventEmitter domain events for the Governance consumer
  (originally planned Sprint 7, re-scoped to Sprint 8; see
  [`phases/sprint-7.md`](../phases/sprint-7.md)).

## Consequences

**Easier:**

- Every tenant-owned model applies the same set; CI guard
  `check-models` flags drift.
- The audit plugin emits lightweight events so the Governance
  consumer (Sprint 8; originally Sprint 7, re-scoped — see
  [`phases/sprint-7.md`](../phases/sprint-7.md)) can subscribe with a
  non-breaking API.
- Single import path (`src/models/plugins/`) for all plugins.

**Harder:**

- Plugins must be applied in the right order; documented.
- `mongoose-paginate-v2` and `mongoose-update-if-current` are
  version-pinned to keep behaviour stable.

## Implementation

- `src/models/plugins/tenantScope.js`
- `src/models/plugins/softDelete.js`
- `src/models/plugins/paginate.js`
- `src/models/plugins/optimisticConcurrency.js`
- `src/models/plugins/audit.js`
- `src/models/plugins/index.js` — barrel export.

## Related

- [`database.md`](../backend/database.md)
- [`multi-tenancy.md`](../backend/multi-tenancy.md)