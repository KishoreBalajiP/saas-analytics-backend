# Email Templates

Built-in transactional email templates (roadmap 2.4). `index.js` registers
each template with its variable contract:

- `auth.password_reset`, `auth.email_verification`, `tenant.invitation`,
  `alert.triggered`.

Platform admins can override a template's subject / text / HTML per locale
over `/api/v1/email-templates` (validated, previewable, versioned,
reversible). `emailService.sendTemplate({ to, template, variables })` renders
the active override and falls back to the built-in here.

Conventions
- Placeholders are `{{ variableName }}` only; values are HTML-escaped in the
  HTML part. No logic, no helpers, no raw output.
- Add a template with `registerBuiltInTemplate({...})` (from this file or the
  owning module); keep texts identical to what the code sent before, so an
  un-customised template renders exactly what users already receive.
- Only reference values passed by the caller; never trust raw user HTML.
