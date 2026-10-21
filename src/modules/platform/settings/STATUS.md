# Platform settings — Status

**Roadmap:** 2.4 (platform configuration surfaces)
**Status:** Implemented
**Exit criteria:** covered by `tests/platform-config/*.test.js`

## Real source files
- Routes: `src/routes/settings.routes.js` (`/api/v1/settings`)
- Controller / validator: `src/controllers/setting.controller.js`, `src/validators/setting.validator.js`
- Services: `src/services/platformSettings.service.js` (platform values), `src/services/setting.service.js` (storage, secret encryption, effective resolution), `src/services/settingRules.js` (per-key validation), `src/services/tenantSettings.service.js` (catalogue + tenant overrides)
- History: `src/models/ConfigRevision.js`, `src/services/configHistory.service.js`
- Permissions: `settings.view`, `settings.update`, `settings.secrets.view`, `settings.secrets.update`
- Migration: `npm run db:encrypt-setting-secrets` (dry run by default) encrypts legacy plaintext secrets

Every change is validated, versioned (optimistic concurrency on `version`,
409 `VERSION_CONFLICT`), recorded in `ConfigRevision` and audited through
`auditLog.service` with secrets redacted. Rollback restores the exact state
of an earlier version and is itself a new version.
