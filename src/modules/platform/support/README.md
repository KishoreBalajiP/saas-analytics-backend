# Platform / support

Support tooling is the **internal escape hatch**. Support Admins use it
to resolve customer issues that the regular APIs cannot: impersonate a
user, recover an account, look up a tenant's data, generate emergency
credentials.

Every action is audited twice: once in `audit-logs/` and again in
`access-logs/` (it's also an HTTP call).

## Why it exists

Real customers will lock themselves out, lose MFA devices, hit billing
walls, or report bugs that need context the public APIs don't expose.
A formal support surface keeps that power disciplined.

## Planned endpoints (`/api/v1/support`)

- `POST /impersonate`             - start an impersonation session (reason required)
- `POST /impersonate/stop`        - end impersonation
- `POST /account/recover`         - reset password / unlock account for a tenant
- `POST /account/revoke-sessions` - kill all sessions for a user
- `GET  /tenants/:id/lookups`     - aggregated view for incident response
- `POST /notifications/broadcast` - one-off cross-tenant announce (Phase 4+)

## Architectural shape

- Service: `src/services/support.service.js` - thin facade that orchestrates
  `services/admin.service.js`, `services/auth.service.js` (Phase 2) and
  `services/notification.service.js`.
- All impersonation events go through `middleware/accessLog.middleware.js`
  AND `middleware/audit.middleware.js` AND `middleware/compliance.middleware.js`.

## Coding guidelines

- All support actions MUST require:
  - a valid `admin` session,
  - the `support.configure` permission on module `support`,
  - a non-empty `reason` body field.
- Impersonation is rate-limited (max N per admin per day).
- Impersonation never grants write access by default; read-only at first.
- Reason must appear in audit + access logs verbatim.

## Future extension

- A "support ticket" workspace (tie to Phase 4+ incidents).
- A read-only mirror database that lets support query without touching
  production hot data.
