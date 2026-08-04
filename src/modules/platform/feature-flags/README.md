# Platform / feature-flags

Feature flags let the platform team ship behaviour behind a runtime gate.
A flag may be on globally, on for a tenant, on for a cohort, or off.

The platform consumes feature flags **on the hot path** via
`platform/feature-flags/resolve`; the cache layer backs this so reads stay
sub-millisecond.

## Why it exists

Decouple deployment from release. Enable a feature for one tenant in
production without redeploying; roll back the same way.

## Data shape (architecture only)

`models/FeatureFlag.js`:

```
_id, key (unique), name, description?,
type: 'boolean' | 'string' | 'number' | 'json',
defaultValue,
rollout?: {
  strategy: 'all' | 'tenantId' | 'percentage' | 'attribute',
  tenantIds?: string[],
  percentage?: number,            // 0..100 with hashed bucketing
  attributeRules?: Array<{ key, op, value }>,
},
createdAt, updatedAt, updatedBy,
```

Indexes: unique(`key`), `{ 'rollout.tenantIds': 1 }`.

## Planned endpoints (`/api/v1/feature-flags`)

- `GET    /`                    - list flags (admin)
- `POST   /`                    - create flag
- `GET    /:key`                - detail
- `PATCH  /:key`                - update rollout strategy
- `DELETE /:key`                - delete (refuses if production-bound)

Plus a **runtime** endpoint used inside the platform:

- `POST   /resolve`            - body `{ tenantId?, userId?, context? }` ->
  map of `{ key: resolvedValue }` for the requested keys (or all).

## Architectural shape

- Service: `src/services/setting.service.js` re-used; `feature-flag.service.js`
  Phase 2 specialises it.
- Repository: backed by `Setting.js` shape; Phase 2 introduces a dedicated
  `FeatureFlag.js` model + `repositories/setting.repository.js`.
- Cache: full flag set cached per tenant with TTL (~30s); admin writes
  invalidate.

## Coding guidelines

- Resolve is the only allowed read API for the running app.
- A flag's `key` is permanent; renaming is not allowed.
- Percentage rollouts use a stable hash of `tenantId` so behaviour is
  deterministic.
- Flags MUST be read fresh on most paths (cached, but invalidated on
  write); the value MUST NOT be baked into a deploy.

## Future extension

- A/B test analytics (each resolve tagged with an experiment id).
- SDKs (server, client, mobile) that consume `/resolve`.
- Flag lifecycle: planned / active / rolled-out / archived.
