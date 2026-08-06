# Backend — Database (MongoDB + Mongoose)

> **WHAT this is:** the deep-dive on MongoDB + Mongoose conventions.
> **WHY it exists:** every tenant-owned collection must follow the
> same conventions; consistency is enforced by the shared plugin set.
> **HOW to use it:** read *Architecture* and *Best Practices* before
> writing a new model.
> **WHEN to update it:** as the conventions evolve.
> **WHERE it lives:** `src/docs/backend/database.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on MongoDB + Mongoose conventions.
> **WHY it exists:** every tenant-owned collection follows the same
> conventions.
> **HOW to use it:** read *Architecture* and *Best Practices*.
> **WHEN to update it:** as the conventions evolve.
> **WHERE it lives:** `src/docs/backend/database.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint implementer** | Has the model conventions. |
| **Tech lead** | Has the index strategy. |

## Current Status

> **Status:** `Implemented` — Sprint 0 ships the plugins; Sprints 1–9
> ship the models.
> **Sprint:** Sprint 0 (plugins); Sprints 1–9 (models).
> **Owner:** Engineering team.

## Business Perspective

The database is MongoDB. Every tenant-owned collection is shaped the
same way: `tenantId` + timestamps + standard indexes. The patterns
are enforced by the shared plugin set.

## Technical Perspective

- Mongoose 8 with the shared plugin set:
  - `tenantScope` (Sprint 0)
  - `softDelete` (Sprint 0)
  - `paginate` (Sprint 0)
  - `optimisticConcurrency` (Sprint 0)
  - `audit` (Sprint 0)
- Compound indexes `{ tenantId: 1, _id: 1 }`, `{ tenantId: 1,
  createdAt: -1 }`.
- TTL indexes on `Session`, `RefreshToken`, `AuditLog`, `AccessLog`,
  `LoginAttempt`.

## Conventions

| Rule | Why |
| --- | --- |
| One model per file | Easier to find, easier to mock. |
| `timestamps: true` | `createdAt` / `updatedAt` automatic. |
| Tenant-owned models include `tenantId` + `tenantScope` plugin | Three-layer isolation. |
| TTL indexes on expiring data | Free cleanup. |
| `lean()` on read paths | No Mongoose overhead in hot reads. |
| Never store secrets in plain text | Use `utils/encryption.js`. |

## Compound Index Strategy

| Pattern | Index | Used by |
| --- | --- | --- |
| Lookup by id within a tenant | `{ tenantId: 1, _id: 1 }` | Every tenant-owned model |
| List by tenant sorted by recency | `{ tenantId: 1, createdAt: -1 }` | List endpoints |
| Unique email per tenant | `{ tenantId: 1, email: 1 } unique` | `User` model |
| Session lookup | `{ sessionId: 1 } unique` | `Session` model |
| Refresh-token lookup | `{ refreshTokenHash: 1 }` | `Session` model |

## Real-world Examples

### A new tenant-owned model

```js
import mongoose from 'mongoose';
import plugins from '../../models/plugins/index.js';

const schema = new mongoose.Schema(
  { tenantId: { type: String, index: true }, name: { type: String } },
  { timestamps: true },
);

schema.plugin(plugins.tenantScope);
schema.plugin(plugins.softDelete);
schema.plugin(plugins.paginate);
schema.plugin(plugins.optimisticConcurrency);
schema.plugin(plugins.audit, { module: 'analytics.dashboards' });

export const Dashboard = mongoose.model('Dashboard', schema);
```

### A read using the scope

```js
Dashboard.useScope({ tenantId: 't_01H...' });
const list = await Dashboard.find({}).sort({ createdAt: -1 }).lean();
```

### A paginated list

```js
const page = await Dashboard.paginate(
  { tenantId: 't_01H...' },
  { page: 1, limit: 20, sort: '-createdAt' },
);
```

## Best Practices

| Do | Why |
| --- | --- |
| **Apply every shared plugin** to tenant-owned models. | CI guard `check-models` enforces it. |
| **Plan indexes at schema creation time.** | Hot-path indexes added later cost more. |
| **Use `.lean()` on read paths.** | No Mongoose overhead. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Storing secrets in plain text.** | Use `utils/encryption.js`. |
| **Skipping the `tenantScope` plugin.** | The CI guard catches it; the rule exists. |
| **Hot-path indexes added after launch.** | Cost more and may require downtime. |

---

## Summary

MongoDB + Mongoose with the shared plugin set. Every tenant-owned
collection applies all five plugins; every index is planned at
schema creation; secrets are encrypted at rest.

## Key Takeaways

- **One model per file.**
- **Five plugins on every tenant-owned model.**
- **`.lean()` on reads.**

## Interview Preparation

### Common Questions

- "Why MongoDB?"
- "How do you handle multi-tenancy in the schema?"

### Sample Answers

- **"Why MongoDB?"** — Document shape fits analytics data; the
  Mongoose plugin model lets us encode tenant scoping and soft
  delete once and apply everywhere.
- **"Multi-tenancy in schema?"** — `tenantId` field + `tenantScope`
  plugin. Three layers of defence.

## Related Documents

- [`../../models/plugins/`](../../../src/models/plugins/) — plugin set
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-007

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)