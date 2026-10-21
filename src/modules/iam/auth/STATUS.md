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

## Hardening (roadmap 1.9, 1.12, auth.14 / sec.14)

- **Cookie-only refresh transport.** Login and refresh bodies carry
  `{ accessToken, expiresIn, sessionExpiresAt, actor }` only; the refresh
  token and session id live in the HttpOnly cookie. Each portal has its own
  cookie name and path (`saas_session` at `/api/v1/auth`,
  `saas_admin_session` at `/api/v1/admin-auth`), and refresh refuses the
  other portal's sessions. The pre-split shared cookie is read once as a
  fallback and cleared. `AUTH_COOKIE_DOMAIN` supports first-party
  deployments with SameSite=Lax.
- **Per-route rate limits** (`rateLimiter.middleware.js`), Redis-backed when
  `REDIS_URL` is set, typed 429 with `Retry-After`.
- **Lockout decay:** the failed-attempt counter restarts once `lockedUntil`
  has passed.
- **Logout** revokes the cookie session and/or the bearer token's session
  and reports `revoked`.
- **Multi-tab refresh:** concurrent refreshes with one token rotate once
  (atomic compare-and-set, `replacedBy`); a duplicate arriving within
  `AUTH_REFRESH_REUSE_GRACE_MS` (default 10 s) of the rotation joins the
  live successor (access token, no new cookie). Later reuse is a replay.
  The SPA also serialises refreshes across tabs (Web Locks +
  BroadcastChannel).
- **Absolute lifetime:** `authenticatedAt` + `familyId` survive rotation;
  refresh fails after `AUTH_SESSION_ABSOLUTE_TTL` (default 30d).
- **Status re-check:** `actorStatus.service.js` makes every authenticated
  request (and socket handshake) fail with 401 once the account or tenant is
  no longer active (short in-process cache, invalidated on change).
- **RBAC cache expiry bound:** `rbac.cache.service.js` never serves a grant
  past its `expiresAt`.
- **Idempotency:** authenticated mutations with `X-Idempotency-Key` replay
  the stored response (keys scoped by actor + tenant + method + path).
- **Socket.IO:** handshake requires a valid access token; rooms are joined
  only for the caller's own tenant/user.

Tests: `tests/auth-hardening.integration.test.js`,
`tests/auth-rate-limit.integration.test.js`,
`tests/rbac/grant-expiry-cache.integration.test.js`,
`tests/websocket/socket-auth.integration.test.js`,
`tests/middleware/idempotency.test.js`, `tests/config/auth-config.test.js`.

## Admin authentication completeness (roadmap 2.2, adminauth)

- **MFA policy** (`adminMfaPolicy.js`, `ADMIN_MFA_REQUIRED_TYPES`, default
  `super,platform`): a privileged admin (type, platform role of that name, or
  `mfaEnrollmentRequired` after an admin-assisted reset) signing in without
  MFA gets a session with `Session.restriction = 'mfa_enrollment'`.
  `authenticateToken({ allowRestrictions })` refuses it everywhere except
  `adminAuthAllowEnrollment` routes (enrol, verify, `/me`, logout) with 403
  `MFA_ENROLLMENT_REQUIRED`; verification lifts it for the whole login.
- **Recovery codes** (`utils/recoveryCodes.js`, shared contract): 10 codes
  issued at enrolment (shown once), stored as SHA-256 digests
  (`Admin.mfaRecoveryCodes`, `select: false`), spent atomically, accepted at
  login, step-up and MFA disable; regeneration needs a step-up.
- **Step-up** (`stepUp.service.js`, `middleware/stepUp.middleware.js`):
  `POST /admin-auth/step-up` stamps `Session.stepUpAt`; `requireAdminStepUp`
  admits sensitive requests for `ADMIN_STEP_UP_TTL_MS` on that session only
  (granting super, credential resets, recovery-code regeneration, secret
  tenant settings). Failures count toward the lockout; the lockout revokes
  every session.
- **Admin-assisted resets** (`services/adminCredentials.service.js`): an
  active super admin (never oneself, step-up) resets another admin's MFA
  (forced re-enrolment) or password (old one void, reset link emailed).
- **Invitations** (`services/adminInvitation.service.js`, `AdminInvitation`):
  `POST /admin/admins` invites (no password); public preview/accept at
  `/admin-auth/invitations/*`; resend cooldown persisted (`AuthCooldown`).
- **Links** (auth.15): admin reset emails link to `/admin/reset-password`;
  lifetimes `PASSWORD_RESET_TTL_MS` (1 h), `EMAIL_VERIFICATION_TTL_MS` (24 h),
  `ADMIN_INVITATION_TTL_MS` (72 h) are stated in the emails; the verification
  resend cooldown is stored in MongoDB, not the process cache.
- Tests: `tests/admin-auth-policy.integration.test.js`,
  `tests/admin-access-management.integration.test.js`,
  `tests/utils/recoveryCodes.test.js`, `tests/utils/stepUp.test.js`,
  `tests/services/authCooldown.integration.test.js`,
  `tests/config/adminauth-config.test.js`.
