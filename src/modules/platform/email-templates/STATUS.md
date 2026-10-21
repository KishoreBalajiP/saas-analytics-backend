# Email templates — Status

**Roadmap:** 2.4 (platform configuration surfaces)
**Status:** Implemented
**Exit criteria:** covered by `tests/platform-config/*.test.js`

## Real source files
- Routes: `src/routes/email-template.routes.js` (`/api/v1/email-templates`)
- Controller / validator: `src/controllers/emailTemplate.controller.js`, `src/validators/emailTemplate.validator.js`
- Service: `src/services/emailTemplate.service.js` (variable contract, safe rendering, preview, history, rollback)
- Built-ins: `src/templates/emails/index.js`; overrides: `src/models/EmailTemplate.js`
- Sending: `emailService.sendTemplate({ to, template, variables, locale })` (override, then English override, then built-in)
- Permissions: `email_templates.view`, `email_templates.update`

Every change is validated, versioned (optimistic concurrency on `version`,
409 `VERSION_CONFLICT`), recorded in `ConfigRevision` and audited through
`auditLog.service` with secrets redacted. Rollback restores the exact state
of an earlier version and is itself a new version.
