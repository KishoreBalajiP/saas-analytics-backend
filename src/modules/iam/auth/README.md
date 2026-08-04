# IAM / auth

Authentication for **both** portals. Admin Portal uses `admin-auth.routes.js`
mounted at `/api/v1/admin-auth`. Tenant Portal uses the existing `/api/v1/
auth` (Phase 1) route - both share the same Service and Repository layer.

## Why it exists

A single, audited, multi-portal authentication surface that:
- proves identity on every request,
- issues short-lived access tokens (JWT) and long-lived refresh tokens
  (opaque, stored in `sessions/`),
- supports MFA for admins, password + SSO for tenants,
- never permits anonymous access to anything beyond `/health` and public
  catalog endpoints.

## Responsibilities (planned, no implementation yet)

- `POST /admin-auth/login`        - platform admin login (email + password + optional MFA)
- `POST /admin-auth/refresh`      - rotate refresh token, issue new access token
- `POST /admin-auth/logout`       - revoke current session
- `POST /admin-auth/mfa/enroll`   - TOTP enrolment
- `POST /admin-auth/mfa/verify`   - TOTP verification
- `GET  /admin-auth/me`           - identity of the current admin
- `POST /auth/login`              - tenant user login (existing route, Phase 1)
- `POST /auth/refresh`            - tenant user refresh
- `POST /auth/logout`             - tenant user logout

## Architectural shape

```
controllers/  -> adminAuth is delegated into controllers/admin.controller.js
                for /admin CRUD; login/logout/refresh live with auth itself
services/      -> services/admin.service.js  (login, refresh, revoke)
                services/auth.service.js    (Phase 1, tenant-side)
repositories/  -> repositories/admin.repository.js + user.repository.js (planned)
models/        -> models/Admin.js, models/User.js, models/Session.js
middleware/    -> middleware/adminAuth.middleware.js, middleware/auth.middleware.js
                (Phase 1)
governance/    -> each login/refresh/logout MUST emit an audit-logs entry
```

## Coding guidelines

- Hashing: Argon2id with per-record salt via `utils/crypto.js` (Phase 2).
- JWT: short-lived (5-15 min) RS256 or EdDSA, signed by platform key.
- Refresh: opaque random 256-bit token, hashed at rest, stored in
  `models/Session.js`.
- Tokens NEVER appear in `audit-logs` or `access-logs` payloads.
- Rate limiting on `/login` and `/refresh` via `rateLimiter.middleware.js`.
- Phase 1.2 ships **architecture only**; every handler currently returns 501.

## Future extension

- SSO: OIDC for tenants (Google Workspace / Microsoft Entra), SAML for
  enterprise tenants.
- WebAuthn (passkeys) for admins.
- Adaptive risk on login: IP reputation, impossible-travel, device
  fingerprint.

See `iam/admins/README.md`, `iam/users/README.md`, `iam/sessions/README.md`.
