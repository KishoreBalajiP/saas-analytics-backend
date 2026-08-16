# Embed Module — Status

**Sprint:** 9 (External API + API Keys + Embed + Product Delivery)
**Status:** ✅ Implemented
**Implements:** public embed surface + management API

## Real Source Files

- `src/models/EmbedToken.js` — tenant-scoped embed token (SHA-256 hashed)
- `src/repositories/embedToken.repository.js` — lean reads, findByTokenHash
- `src/services/embed.service.js` — create/revoke/list/resolve/execute
- `src/controllers/embed.controller.js` — management handlers
- `src/routes/embed.routes.js` — `/tokens` (JWT+RBAC) + `/:token` (public, ci:routes-exempt)
- `src/validators/embed.validator.js` — create/revoke schemas

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/v1/embed/tokens` | JWT + `embed.create` | Create token for published dashboard |
| GET | `/api/v1/embed/tokens` | JWT + `embed.view` | List tokens (optionally by dashboard) |
| GET | `/api/v1/embed/tokens/:id` | JWT + `embed.view` | Get token metadata |
| POST | `/api/v1/embed/tokens/:id/revoke` | JWT + `embed.delete` | Revoke token |
| GET | `/api/v1/embed/:token` | **none** (token in path) | Public embed read — resolves token, executes dashboard/widget |

## Security Contract

- Token secret returned **once** at creation; only `tokenHash` (SHA-256) persisted.
- Public route is token-gated: resolves SHA-256 hash → validates `status=active` + `expiresAt > now` + `deletedAt=null` → re-checks dashboard is still `published`.
- No JWT, no cookies, no credentials on public read.
- CORS: reflects all Origins (`config.security.embed.corsAllowAllOrigins = true`).
- Dedicated rate limiter (`config.security.rateLimit.embed`: 120 req/min per IP).
- Scoped to one dashboard (optional single widget).

## Dependencies

- `dashboard.service.viewDashboard` / `executeWidget` (execution backend)
- `analytics.engine.queryRows` (analytics engine)
- `tenantScope` plugin (tenant isolation on management endpoints)

## Tests

- `tests/embed/embed.routes.integration.test.js` — token create/list/revoke, public embed read (valid/expired/invalid/unpublished), cross-tenant isolation.

## Sprint 9 Notes

The original plan ("Analytics + Embed" with dashboards/reports) was stale.
Sprint 9 actually delivered: **External API + API Keys + Embed + Product Delivery**.
See `src/docs/phases/sprint-9.md` for the full delivery record.

## Last Updated

- **Sprint:** Sprint 9 close
- **Date:** 2026-08-16
- **Author:** Engineering