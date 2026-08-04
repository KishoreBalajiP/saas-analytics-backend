# IAM - Identity & Access Management

The IAM umbrella governs **who** can do **what** on the platform. It is the
single source of truth for identity (admins, users, tenants), roles,
permissions and sessions across the Admin Portal, Tenant Portal, Mobile App,
Embeddable Widget and Public APIs.

## Submodules

| Submodule      | Responsibility                                           | Entry file                |
| -------------- | -------------------------------------------------------- | ------------------------- |
| `auth`         | Login/refresh/logout for both Admin and Tenant portals   | `routes/admin-auth.routes.js` (+ tenant `/auth` from Phase 1) |
| `admins`       | Platform Admin accounts (Super / Platform / Support)     | `routes/admin.routes.js`  |
| `users`        | Tenant end-user accounts                                 | (covered under `/admin`) |
| `tenants`      | Organisations, plans, statuses, lifecycle               | `routes/tenant.routes.js` |
| `roles`        | Dynamic roles (collections of permissions)              | `routes/role.routes.js`   |
| `permissions`  | Dynamic permissions, modules, actions                   | `routes/permission.routes.js` |
| `sessions`     | Active sessions, refresh tokens, revocation             | (internal, see README)    |

## Architectural principles

1. **Single backend, two portals.** Admin and Tenant Portals hit the same
   routes, differentiated by RBAC. There is **no separate admin backend**.
2. **Dynamic RBAC.** Roles and permissions are data, not code. New modules or
   actions are added by inserting rows, never by editing permission checks.
3. **Tenant isolation by default.** Every request resolves a tenant scope;
   the `tenantIsolation.middleware.js` enforces it. Platform Admins get an
   opt-out scope flag.
4. **Fail-closed auth.** A missing or invalid credential always returns 401.
   A missing permission always returns 403. There is no "default allow".
5. **Sessions are first-class citizens.** Refresh tokens, device binding and
   revocation are modelled as data, not implicit cookies.

## Relationship with other modules

- **IAM** owns identities and permission decisions. It depends on:
  - `governance/audit-logs/` - every auth event must be recorded.
  - `governance/access-logs/` - every authenticated request must be logged.
- **IAM** does NOT own tenant business data; that lives in the relevant
  module (connectors, analytics, etc.) and is gated by `tenantId`.
- **Platform** modules (master-data, settings, feature-flags) define what
  IAM may do; IAM enforces it.

## Future implementation (Phase 2+)

- Mongoose schemas for Admin / User / Tenant / Role / Permission.
- Argon2id password hashing via `utils/crypto.js`.
- JWT access tokens (short TTL) + opaque refresh tokens stored in `sessions`.
- MFA (TOTP) for admins - mandatory for Super Admin.
- SCIM 2.0 provisioning for enterprise tenants.
- OAuth 2.0 / SAML SSO for tenant login.

## Coding guidelines

- All IAM endpoints pass through `adminAuth` or tenant `auth` middleware
  before any other middleware (so 401 happens as early as possible).
- The order of middleware on protected routes:
  `auth -> tenant -> rbac -> modulePermission -> permission -> handler`.
- Never log credentials, sessions or tokens. The governance middleware
  records the *fact* of the event, not its secrets.
- Repositories return lean objects; services throw `ApiError`.

See `iam/<submodule>/README.md` for submodule details.
