# Module — Status

**Status:** ✅ Implemented (Sprint 8; roadmap 2.5 - API-key and sign-in traffic, path without query string, export filters and ids, flush on shutdown)

**Source files**
- `src/middleware/accessLog.middleware.js` - captures user/admin requests, API-key calls (`actorType: 'service'`, `event: 'api_key'`) and the sign-in surface (`event: 'auth.<step>'`, failed logins included); `path` never contains the query string.
- `src/services/accessLog.service.js` - buffered capture (`flush()` also waits for batches in flight; called by the graceful-shutdown `access-log` step), reads, aggregations, exports with the access-log filter whitelist and the row id in the CSV `id` column.
- `src/models/AccessLog.js` - append-only (`plugins/appendOnly.js`; retention purge only).
- Read API: `src/routes/access-log.routes.js`, `src/controllers/accessLog.controller.js`.
- Sign-in attempt trail: `GET /access-logs/login-attempts` (`access_logs.view`) lists every `LoginAttempt` (email, ip, user agent, outcome, reason); scoped admins are pinned to their tenant (finding gov.08). `LoginAttempt` is append-only; `loginAttempt.repository#retentionPurge` is its only delete path.

**Tests:** `tests/audit/access-log-and-viewer.integration.test.js`.
