# Module — Status

**Sprint:** 5 — Analytics Engine + Master Data
**Status:** ✅ Implemented

**Implements:** the platform-wide reference-data catalogue consumed by
forms, dashboards and later sprints. A `MasterData` model discriminated by
`category` (countries, currencies, timezones, plans, languages, …).

**Real source files:**

- `src/models/MasterData.js` — global (not tenant-scoped); no
  `tenantScope` plugin.
- `src/services/masterData.service.js` — `list` / `getById` (public,
  cached at `master-data:<category>`) + `create` / `update` / `remove`
  (admin write surface).
- `src/routes/master-data.routes.js` — `GET /:catalogue` (public,
  cached), `GET /:catalogue/:id`, `POST`/`PATCH`/`DELETE` behind
  `adminAuth`; `POST /:catalogue/import|export` remain 501.
- `src/controllers/masterData.controller.js`, `src/validators/
  masterData.validator.js`.

**Testing:** 8 tests — `tests/master-data/masterData.test.js` (CRUD +
cache hit + admin gate).

**Depends on:** Sprint 0 (cache), Sprint 2 (admin RBAC).

**Notes:** Master Data was originally planned as Sprint 6; it moved to
Sprint 5 when the analytics engine became its first consumer.
