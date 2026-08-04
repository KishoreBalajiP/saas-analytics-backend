# Platform / email-templates

Transactional email templates live here. Templates are **data** (subject,
sender, locale-tagged body in MJML or HTML), not code. The worker resolves
variables server-side and routes through `config/mail.js`.

## Why it exists

- Brand consistency (one place for tone, layout, footer).
- Localisation without touching code.
- Auditable change history (every update goes through audit middleware).
- Safe rendering: no template injection at runtime.

## Data shape (architecture only)

`models/EmailTemplate.js`:

```
_id, key (unique),                     // e.g. 'admin.invite'
description,
sender: { name, email },
subject,                               // supports {{var}} placeholders
bodyMjml,                              // MJML source
bodyHtml?,                             // pre-rendered fallback
text?,                                 // plain-text fallback
locale: 'en' | string,                 // primary locale of this template
status: 'draft' | 'active' | 'archived',
variables: Array<{ key, description, required }>,
updatedAt, updatedBy
```

A template can have multiple rows - one per `locale` - sharing the same
`key`. The dispatcher picks the tenant's default locale and falls back.

## Planned endpoints (`/api/v1/email-templates`)

- `GET    /`             - list
- `POST   /`             - create
- `GET    /:id`          - detail (resolved locale-aware)
- `PATCH  /:id`          - update body / subject
- `POST   /:id/activate` - flip to active
- `POST   /:id/archive`  - archive
- `POST   /:id/preview`  - render with sample data (admin-only)

## Architectural shape

- Service: `src/services/notification.service.js` re-uses this module;
  Phase 2 introduces `src/services/emailTemplate.service.js`.
- Models: `src/models/EmailTemplate.js`.
- Workers: `src/jobs/email.job.js` picks queued sends, calls
  `mailer.render(templateKey, locale, data)` and dispatches via SMTP.

## Coding guidelines

- Templates store MJML; the server compiles to HTML at send time.
- Variable substitution is via a small safe helper; NO inline eval.
- A template cannot be deleted if a send is queued - archive instead.
- All template edits go through `audit.middleware.js`.

## Future extension

- Per-tenant template overrides (white-labelling).
- A/B testing of subject lines.
- Bounce / complaint tracking via SES / SendGrid webhooks (recorded as
  `governance/access-logs/` entries).
