# Backend — Multi-Tenancy

> **WHAT this is:** the deep-dive on tenant resolution, isolation and
> scoping.
> **WHY it exists:** multi-tenancy is the platform's core promise;
> the three layers of defence are documented here.
> **HOW to use it:** read *Architecture* and *Best Practices*.
> **WHEN to update it:** as the strategy evolves.
> **WHERE it lives:** `src/docs/backend/multi-tenancy.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on multi-tenancy.
> **WHY it exists:** multi-tenancy is the platform's core promise.
> **HOW to use it:** read *Architecture* and *Best Practices*.
> **WHEN to update it:** as the strategy evolves.
> **WHERE it lives:** `src/docs/backend/multi-tenancy.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 2 implementer** | Has the full plan. |
| **Security reviewer** | Has the three layers. |

## Current Status

> **Status:** `Planned` — Sprint 1 ships `resolveTenant`; Sprint 2
> ships `tenantIsolation`; the `tenantScope` plugin already exists
> (Sprint 0).
> **Sprint:** Sprints 1–2.
> **Owner:** Engineering team.

## Business Perspective

Every customer is a tenant. Tenant data is the customer's; cross-
tenant leakage is a security incident. The platform promises three
layers of defence so a coding mistake in one layer does not become
a breach.

## Technical Perspective

`Tenant` is the root record. Every tenant-owned collection carries
`tenantId`. Three layers:

1. `resolveTenant` middleware — which tenant does this request
   belong to?
2. `tenantIsolation` middleware — is the actor allowed to touch
   this tenant's resources?
3. `tenantScope` Mongoose plugin — does the query filter on
   `tenantId`?

Plus: `tenantScope: '*'` for support admins (read across tenants).

## Architecture

```
Request arrives
    │
    ▼
┌─────────────────────────────────────────────┐
│  resolveTenant middleware                    │
│  Priority:                                  │
│    1. X-Tenant-Id header (must match JWT)    │
│    2. JWT tenantId claim                     │
│    3. Subdomain (Phase 4+)                   │
│  Result: req.tenant = { id, scope }          │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  tenantIsolation middleware                  │
│  - actor.tenantScope === '*' → bypass       │
│  - actor.tenantId === req.tenant.id → allow  │
│  - else → 403                                │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  Repository + tenantScope plugin             │
│  - find filters on tenantId automatically    │
│  - save requires tenantId                    │
└─────────────────────────────────────────────┘
```

## Three Layers in Detail

### Layer 1 — `resolveTenant`

- Reads `X-Tenant-Id` header. If present, **must** match the JWT
  `tenantId` claim; otherwise 403.
- Falls back to JWT `tenantId`.
- Phase 4+ adds subdomain parsing (`*.saas-analytics.com`).

### Layer 2 — `tenantIsolation`

- Reads `req.actor.tenantScope`. If `'*'` (support admin), allow.
- If `req.actor.tenantId !== req.tenant.id`, return 403.
- Optional: per-tenant allow-list for support admins.

### Layer 3 — `tenantScope` Mongoose plugin

- Pre-find middleware injects `tenantId` from the active scope.
- Pre-save middleware refuses to persist a document without
  `tenantId` (unless `optional: true` is set on the schema).
- `Model.useScope({ tenantId })` activates the scope.
- `Model.useScope({ tenantScope: '*' })` bypasses the filter.

## Real-world Examples

### Tenant-scoped query

```js
Model.useScope({ tenantId: 't_01H...' });
const docs = await Model.find({});
// → only documents with tenantId === 't_01H...' are returned
```

### Support admin reads across tenants

```js
Model.useScope({ tenantScope: '*' });
const all = await Model.find({});
// → every tenant's documents are returned
```

### Attempt to read another tenant's data (rejected)

```js
Model.useScope({ tenantId: 't_AAA' });
const other = await Model.find({ tenantId: 't_BBB' }); // explicit, but plugin rejects
// → [] (the plugin ignores the explicit tenantId because the scope has one)
```

Or:

```js
const other = await Model.findOne({ tenantId: 't_BBB' });
// → the plugin would reject this in pre-save, but find returns []
// because the scope's tenantId is t_AAA, so the plugin
// overrides the explicit tenantId to t_AAA
```

## Best Practices

| Do | Why |
| --- | --- |
| **Always use `Model.useScope(...)` before tenant-scoped queries.** | The plugin is the safety net; use the explicit API to be unambiguous. |
| **Apply `tenantScope` to every tenant-owned model.** | CI guard `check-models` enforces it. |
| **Trust the JWT, not the header.** | The header is a hint; the JWT is the truth. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Trusting the `X-Tenant-Id` header alone.** | A client can set any header. Always reconcile with the JWT. |
| **Bypassing `tenantIsolation` for "trusted" actors.** | The plugin is the safety net; bypass it once and you have a leak. |
| **Sharing documents across tenants.** | Every tenant-owned record carries exactly one `tenantId`. |

## Future Work

| Item | Phase |
| --- | --- |
| **Subdomain-based tenant resolution** | Phase 4 |
| **Data residency per tenant** | Phase 4 |
| **Per-tenant encryption contexts** | Phase 4 (envelope `v2`) |

---

## Summary

Multi-tenancy is enforced in three layers: `resolveTenant`,
`tenantIsolation`, `tenantScope`. Forgetting any one is a bug, not a
security incident — the other layers still catch it.

## Key Takeaways

- **Three layers of defence.**
- **Trust the JWT, not the header.**
- **Every tenant-owned model applies `tenantScope`.**

## Interview Preparation

### Common Questions

- "How do you prevent cross-tenant access?"
- "What is the role of the JWT in tenant resolution?"

### Sample Answers

- **"Cross-tenant access?"** — Three layers. (1) `resolveTenant`
  decides which tenant the request belongs to. (2) `tenantIsolation`
  checks the actor is allowed to touch that tenant. (3) The
  `tenantScope` Mongoose plugin auto-injects the tenant filter on
  every read and refuses to save without one.

- **"JWT role?"** — The JWT is the source of truth. The
  `X-Tenant-Id` header is a hint that must reconcile with the JWT;
  if they disagree, 403.

## Related Documents

- [`../phases/sprint-2.md`](../phases/sprint-2.md) — sprint plan
- [`../../modules/plugins/tenantScope.js`](../../../src/models/plugins/tenantScope.js)
- [`../../modules/iam/tenants/README.md`](../../../src/modules/iam/tenants/README.md)
- [`02-project-vision.md`](../02-project-vision.md) — the *why*

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprints 1–2
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)