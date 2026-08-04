# Platform / master-data

Master Data is the **catalogue of lookups** every other module depends on:
countries, currencies, timezones, plans, themes, languages, permission
categories, feature-flag catalogue, email templates, notification templates
and system settings.

Master data is **global by default**. Tenant-scoped master data (e.g.
white-labelled themes, tenant-overridden settings) lives under
`platform/settings/` or in the relevant tenant record.

## What we will model (Phase 2)

| Catalogue                 | Example fields                                          |
| ------------------------- | ------------------------------------------------------- |
| Countries                 | ISO-3166 alpha-2/3, name, dial code, EU member flag     |
| Currencies                | ISO-4217 code, name, symbol, decimals                   |
| Timezones                 | IANA zone, UTC offset, DST observed                     |
| Subscription plans        | code, name, price, period, included features            |
| Connector types           | id, display name, capabilities, icon                    |
| Themes                    | id, name, tokens (json), preview                        |
| Languages                 | ISO-639, display name, RTL flag                         |
| Permission categories     | id, name, parent category                               |
| Feature flags catalogue   | id, key, default, description, type                     |
| Email templates           | id, key, subject, body(MJML), locale                    |
| Notification templates    | id, channel, key, body, variables                       |
| System settings           | key, value, scope (platform/tenant), type               |

## Planned endpoints (`/api/v1/master-data`)

Two surfaces:

1. **Admin** (writes + reads): used by the Admin Portal to manage the
   catalogue. Examples:
   - `POST /countries`       - add a country
   - `PATCH /plans/:code`    - update a plan
   - `POST /themes`          - register a theme
2. **Public** (reads only): used by the Tenant Portal, Mobile App, Embed
   and Public APIs. Backed by the cache layer (`src/cache/`).

The service layer exposes two flavours of the same catalogue, only the
read variants cache aggressively.

## Architectural shape

- Service: `src/services/masterData.service.js` - thin CRUD against
  catalogue repositories.
- Repositories: `src/repositories/masterData.repository.js` (one
  underlying Mongo collection per catalogue).
- Models: `src/models/Setting.js` covers system settings; other catalogues
  are plain JSON documents (Phase 2 models land then).

## Coding guidelines

- Master data writes are admin-gated + audited.
- Reads from cached endpoints MUST include `?locale` if any localisable
  field is returned (Phase 2).
- Never accept catalogue data from a tenant; always from a Platform Admin.
- Every catalogue has a `version` field; clients pass `If-Match` for
  optimistic concurrency on update.

## Future extension

- Versioned releases (`platform/master-data/releases/:version`) for big
  schema-friendly migrations.
- CSV import/export for catalogues (via `connectors/csv/`).
- Webhooks on master-data changes for downstream systems.
