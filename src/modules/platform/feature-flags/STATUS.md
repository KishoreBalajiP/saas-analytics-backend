# Feature flags — Status

**Roadmap:** 2.4 (platform configuration surfaces)
**Status:** Implemented
**Exit criteria:** covered by `tests/platform-config/*.test.js`

## Real source files
- Routes: `src/routes/feature-flag.routes.js` (`/api/v1/feature-flags`, admin CRUD + `GET /evaluate` for workspaces)
- Controller / validator: `src/controllers/featureFlag.controller.js`, `src/validators/featureFlag.validator.js`
- Service: `src/services/featureFlag.service.js` (validation, versioned writes, evaluation, `isEnabled(key, { tenantId })`)
- History: `src/models/ConfigRevision.js` (kind `feature_flag`)
- Permissions: `feature_flags.view/create/update/delete` (platform); tenant roles hold `feature_flags.view` for evaluation

Every change is validated, versioned (optimistic concurrency on `version`,
409 `VERSION_CONFLICT`), recorded in `ConfigRevision` and audited through
`auditLog.service` with secrets redacted. Rollback restores the exact state
of an earlier version and is itself a new version.
