# Module — Status

**Sprint:** 1 (authentication - closing)
**Status:** ✅ Implemented and integration-tested
**Implements:** models, repositories, validators, controllers, auth middleware
and the live `/auth/*` + `/admin-auth/*` routes for both portals
**Real source files:** `User.js`, `Admin.js`, `Tenant.js`, `Session.js`,
`LoginAttempt.js` (models); `user.repository.js`, `admin.repository.js`,
`session.repository.js`, `loginAttempt.repository.js`; `auth.service.js`,
`session.service.js`, `mfa.service.js`, `password.service.js`;
`src/validators/auth.validator.js`, `src/validators/admin.validator.js`;
`src/modules/iam/auth/auth.controller.js`, `mfa.controller.js`,
`password.controller.js`; `src/middleware/auth.middleware.js`,
`adminAuth.middleware.js`, `tenant.middleware.js`; `src/routes/auth.routes.js`,
`src/routes/admin-auth.routes.js`
**Hook points:** shared infrastructure (cache/queue/storage/email + Mongoose
plugins) is in place; RBAC roles for `authorize(...)` are the remaining
Sprint 1 closure work

Sprint 1 ships authentication for both portals (`/auth/*` + `/admin-auth/*`).
Done: the 5 models, the 4 repositories, the 4 services (login / refresh /
logout / password reset / TOTP MFA), the 2 validators, the 3 controllers
(auth / mfa / password), the real middleware (`authenticate` / `authorize` /
`optionalAuthenticate` / `adminAuth` / `adminAuthOptional` / `resolveTenant`)
and the real route handlers behind `strictLimiter` + `validateRequest`.
Integration-tested against `mongodb-memory-server`: login → me → logout for
both portals, refresh rotation with family revocation on replay, MFA
enrolment/verify with real TOTP codes, password reset (no user enumeration,
session family revoked on reset), account lockout, deterministic
refresh-token lookup and idempotent session revoke. Suite: 124 tests, 0 fail
(scrypt mode); `npm run test:argon2` exercises the real Argon2id KDF.
What remains before the sprint closes: RBAC roles for `authorize(...)` (which
currently fails closed until roles land). The Definition of Done checklist is
in `src/docs/phases/sprint-1.md`.

The next sprint that touches this module is documented in the parent
`CHANGELOG.md` and `src/docs/DECISIONS.md`.
