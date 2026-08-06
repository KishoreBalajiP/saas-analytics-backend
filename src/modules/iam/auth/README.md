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

## Responsibilities (Sprint 1: implemented)

- `POST /admin-auth/login`        - platform admin login (email + password + optional MFA)
- `POST /admin-auth/refresh`      - rotate refresh token, issue new access token
- `POST /admin-auth/logout`       - revoke current session
- `POST /admin-auth/mfa/enroll`   - TOTP enrolment
- `POST /admin-auth/mfa/verify`   - TOTP verification
- `GET  /admin-auth/me`           - identity of the current admin
- `POST /admin-auth/password/forgot` - request a password reset email
- `POST /admin-auth/password/reset`  - consume a reset token
- `POST /auth/login`              - tenant user login (existing route, Phase 1)
- `POST /auth/refresh`            - tenant user refresh
- `POST /auth/logout`             - tenant user logout
- `POST /auth/password/forgot`    - request a password reset email
- `POST /auth/password/reset`     - consume a reset token

All of the above are implemented: the services in `auth.service.js`,
`session.service.js`, `mfa.service.js` and `password.service.js`, the
validators in `src/validators/auth.validator.js` / `admin.validator.js`, the
thin controllers in this module, and the real route handlers wired in
`src/routes/auth.routes.js` / `admin-auth.routes.js` behind `strictLimiter` +
`validateRequest` + (`authenticate` / `adminAuth` / `resolveTenant`).
Integration-tested against `mongodb-memory-server`
(`tests/*.integration.test.js`). Remaining Sprint 1 work: RBAC roles for
`authorize(...)`.

## Password KDF seam

Password/refresh-token hashing supports two KDFs, selected by `PASSWORD_KDF`:

- `argon2` (default, production) — Argon2id via the `argon2` package.
- `scrypt` (test/portable) — Node's built-in `crypto.scrypt`
  (N=16384, r=8, p=1, keylen=32), used by `npm test` so the suite runs on
  any machine without a native binary.

Hash formats are self-describing PHC strings
(`$argon2id$...` / `$scrypt$N=...,r=...,p=...$...`), so `verify()` dispatches
by prefix. `npm run test:argon2` runs the same suite against the real
Argon2id KDF. See `src/utils/password.js`.

## Architectural shape

```
controllers/  -> adminAuth is delegated into controllers/admin.controller.js
                for /admin CRUD; login/logout/refresh live with auth itself
services/      -> auth.service.js / session.service.js / mfa.service.js /
                password.service.js (implemented, Sprint 1)
repositories/  -> repositories/user.repository.js + admin.repository.js +
                session.repository.js + loginAttempt.repository.js
models/        -> models/Admin.js, models/User.js, models/Session.js,
                models/LoginAttempt.js
middleware/    -> middleware/auth.middleware.js (authenticate / authorize /
                optionalAuthenticate), adminAuth.middleware.js (adminAuth /
                adminAuthOptional), tenant.middleware.js (resolveTenant) -
                all implemented
governance/    -> each login/refresh/logout MUST emit an audit-logs entry
```

## Coding guidelines

- Hashing: Argon2id (or scrypt in test mode) with per-record salt via
  `utils/password.js`.
- JWT: short-lived (5-15 min) RS256 or EdDSA, signed by platform key.
- Refresh: opaque random 256-bit token, hashed **deterministically** at rest
  (salt = SHA-256 of the token) and stored in `models/Session.js` — the
  session lookup hashes the presented token to find the row, so the hash
  must be reproducible; the token itself is never stored in plain text.
- Tokens NEVER appear in `audit-logs` or `access-logs` payloads.
- Rate limiting on `/login` and `/refresh` via `rateLimiter.middleware.js`.
- `authorize(...)` currently fails closed (403) until RBAC roles land.

## Future extension

- SSO: OIDC for tenants (Google Workspace / Microsoft Entra), SAML for
  enterprise tenants.
- WebAuthn (passkeys) for admins.
- Adaptive risk on login: IP reputation, impossible-travel, device
  fingerprint.

See `iam/admins/README.md`, `iam/users/README.md`, `iam/sessions/README.md`.
