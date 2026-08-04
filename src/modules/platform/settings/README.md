# Platform / settings

Settings: typed, scoped, hot-reloadable configuration values. Two scopes:

- **Platform** - applies to the whole SaaS (one source of truth, broadcast).
- **Tenant**   - applies to one tenant (overrides platform defaults).

Every business module reads settings; none of them own settings.

## Why it exists

Without settings, every change is a redeploy. With settings, the platform
team can:
- switch a feature on for one tenant,
- change rate limits without rolling pods,
- tune email templates, timeouts, branding,
- expose the same surface to customers (whitelabelling).

## Data shape (architecture only)

`models/Setting.js`:

```
_key: string,                             // e.g. 'analytics.cache.ttl'
scope: 'platform' | 'tenant',
tenantId?: string,                        // present when scope = tenant
type: 'string' | 'number' | 'boolean' | 'json' | 'duration',
value: any,                               // typed to match `type`
description?, isSecret, isReadonly,
version: number,                          // optimistic concurrency
updatedBy, updatedAt
```

Indexes: `{ scope: 1, tenantId: 1, _key: 1 }` unique.

## Planned endpoints (`/api/v1/settings`)

- `GET    /`                                 - list (platform admin only)
- `GET    /:key`                             - get one (with scope resolution)
- `PUT    /:key`                             - update (optimistic concurrency)
- `POST   /`                                 - create
- `DELETE /:key`                             - delete (refuses if read-only)
- `GET    /tenants/:tenantId/settings`       - tenant-specific list

## Architectural shape

- Service: `src/services/setting.service.js` - scopes and validates writes,
  resolves effective value with caching.
- Repository: `src/repositories/setting.repository.js`.
- Model: `src/models/Setting.js`.

## Coding guidelines

- All reads go through the cache (`src/cache/`) keyed by scope + key.
- Cache invalidated on write (single-key + bulk).
- `isSecret: true` settings are NEVER returned in plaintext from `GET`.
- `isReadonly: true` settings return 409 from `PUT`/`DELETE`.
- Every write emits an audit event.

## Future extension

- Setting groups (UI grouping in the Admin Portal).
- Setting history viewer.
- Environment-aware settings (dev / staging / prod overrides per key).
