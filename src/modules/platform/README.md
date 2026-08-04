# Platform - Cross-cutting Configuration & Operations

Platform modules are the **non-IAM, non-business** backbone: master data,
settings, feature flags, monitoring, notifications, email templates and
support tooling. Every other module reads from Platform; few write to it.

## Submodules

| Submodule          | Responsibility                                       | Entry file                        |
| ------------------ | ---------------------------------------------------- | --------------------------------- |
| `master-data`      | Countries, currencies, timezones, plans, themes, ... | `routes/master-data.routes.js`    |
| `settings`         | Platform and tenant-scoped system settings           | `routes/settings.routes.js`       |
| `feature-flags`    | Dynamic feature flags (per tenant or global)         | `routes/feature-flag.routes.js`   |
| `monitoring`       | Health probes for every subsystem                    | `routes/monitoring.routes.js`     |
| `notifications`    | In-app / push notification fan-out                   | `routes/notification.routes.js`   |
| `email-templates`  | Transactional email template registry                | `routes/email-template.routes.js` |
| `support`          | Internal tooling: impersonation, lookups, recovery   | `routes/support.routes.js`        |

## Architectural principles

1. **Read-mostly.** Most platform modules are C(R)UD where the "R" and
   read-paths dominate. Heavy caching via `src/cache/` is expected.
2. **No business logic.** Platform modules MUST NOT contain domain logic.
   They define *what is*, not *what happens*.
3. **Tenant-scopable.** Settings, feature flags and notifications are
   tenant-scoped records with a `tenantId` field. Master data is global.
4. **Audited.** Every write goes through the `audit.middleware.js`.
5. **Hot-reloadable.** Settings and feature flags are read fresh on every
   request (with a TTL cache) so platform teams can change behaviour
   without redeploying.

## Master data - what we will model

The `platform/master-data/` module will host the canonical lookup data that
every other module depends on:

| Category                | Example fields                                  | Scope     |
| ----------------------- | ----------------------------------------------- | --------- |
| Countries               | ISO-3166 alpha-2/3, name, dial code, EU member? | global    |
| Currencies              | ISO-4217 code, name, symbol, decimals           | global    |
| Timezones               | IANA zone, UTC offset, dst observed?            | global    |
| Subscription plans      | code, name, price, period, included features    | global    |
| Connector types         | id, display name, capabilities, icon            | global    |
| Themes                  | id, name, tokens (json), preview                | platform  |
| Languages               | ISO-639, display name, RTL flag                 | global    |
| Permission categories   | id, name, parent category                       | global    |
| Feature flags catalogue | id, key, default, description, type             | global    |
| Email templates         | id, key, subject, body(MJML), locale            | global    |
| Notification templates  | id, channel, key, body, variables               | global    |
| System settings         | key, value, scope (platform/tenant), type       | both      |

## Relationship with other modules

- **IAM** consumes Platform (settings + feature flags) and Master Data (countries, languages).
- **Connectors** consume Master Data (connector types, currencies).
- **Governance** watches Platform (audit writes come from settings/feature-flag changes).
- **Analytics** consume Platform Master Data (currencies, timezones for formatting).

## Future implementation (Phase 2+)

- Seeders for global master data (countries, currencies, timezones).
- A global cache key per setting/flag, with safe negative caching.
- Versioned settings: every change stores `{value, changedBy, changedAt, reason}`.
- Webhooks on feature-flag + setting changes for downstream consumers.
- A dedicated `platform/scheduler/` for periodic master-data sync (e.g., ECB rates).

## Coding guidelines

- Platform endpoints require `adminAuth` + `modulePermission('platform', ...)`.
- Master data endpoints are admin-only; tenant-facing reads come through a
  cached public read-only projection.
- Master data caches are invalidated on write.

See each `platform/<submodule>/README.md` for details.
