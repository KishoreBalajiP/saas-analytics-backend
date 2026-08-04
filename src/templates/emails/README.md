# Email Templates

Future email templates live here (one file per email, alongside any shared
partials). The email queue job (`src/jobs/email.job.js`) and mail config
(`src/config/mail.js`) are already prepared.

Expected layout once email lands:

```text
templates/emails/
├── base.html            # shared shell/layout
├── welcome.email.html   # welcome email
├── password-reset.email.html
└── alert.email.html
```

Conventions
- Server-rendered, well-tested templates - never string-concatenated HTML.
- Only reference values passed by the caller; never trust raw user HTML.
