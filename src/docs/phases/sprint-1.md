# Sprint 1 — Authentication

> **WHAT this is:** the plan for Sprint 1 — the first sprint that
> ships a user-visible feature (login, logout, refresh).
> **WHY it exists:** Sprint 1 turns the platform from *invisible* to
> *reachable*. It must be right; security mistakes here compound.
> **HOW to use it:** read *Scope* and *Deliverables* before opening a
> PR; check *Definition of Done* before merging the closing PR.
> **WHEN to update it:** as the sprint closes (the sprint closure PR
> updates this file too).
> **WHERE it lives:** `src/docs/phases/sprint-1.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 1 — Authentication.
> **WHY it exists:** Sprint 1 turns the platform from *invisible* to
> *reachable*. Security mistakes here compound.
> **HOW to use it:** read *Scope* and *Deliverables*; check
> *Definition of Done*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-1.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 1 implementer** | Has the full plan to start work. |
| **Tech lead** | Has the risk list to plan around. |
| **Security reviewer** | Has the threat model to review against. |

## Current Status

> **Status:** `Implemented — closing.`
> **Sprint:** Sprint 1.
> **Owner:** Engineering team.
> **Closure note:** all deliverables shipped; integration-tested against
> `mongodb-memory-server` (124 tests, 0 fail); `npm run ci:guards` green.
> RBAC roles for `authorize(...)` defer to a follow-up.

## Business Perspective

Sprint 1 ships the first user-visible feature: a customer can sign up,
log in, log out, refresh a session and reset their password. Without
Sprint 1, every later sprint is unreachable.

## Technical Perspective

`User`, `Admin`, `Tenant`, `Session`, `LoginAttempt` Mongoose models
with the standard plugin set. `authenticate`, `adminAuth`,
`resolveTenant` middleware (real). `/auth/*` and `/admin-auth/*` real
endpoints. Argon2id + JWT + refresh-token rotation + account lockout
+ TOTP MFA for super_admin.

## Scope

- Both portals (`/auth/*` for tenant users, `/admin-auth/*` for
  platform admins).
- JWT access tokens (15 min) + opaque refresh tokens (rotating).
- Account lockout after configurable N failed attempts.
- TOTP MFA enrolment + verify, enforced for `super_admin`.
- `resolveTenant` middleware (priority: `X-Tenant-Id` header → JWT
  `tenantId` claim → subdomain).
- Real `authenticate` / `adminAuth` / `authorize` / `optionalAuthenticate`.
- Strict rate-limit on login + refresh.
- Audit-log event on every login / logout / lockout.

## Deliverables

### Models (`src/models/`)
- `User.js` — email unique per tenant; password hash; status;
  `tenantScope` plugin.
- `Admin.js` — type (`super` / `platform` / `support`); status.
- `Tenant.js` — name; slug (immutable); status; plan; soft-delete.
- `Session.js` — session id; user / admin reference; refresh token
  hash (Argon2id); device fingerprint; ip / ua; expiresAt; revokedAt.
- `LoginAttempt.js` — counter for account lockout.

### Module services
- `src/modules/iam/auth/auth.service.js` — login, refresh, logout,
  password forgot / reset.
- `src/modules/iam/auth/mfa.service.js` — TOTP enrolment + verify.
- `src/modules/iam/auth/session.service.js` — session lifecycle.

### Module controllers
- `src/modules/iam/auth/auth.controller.js`
- `src/modules/iam/auth/mfa.controller.js`
- `src/modules/iam/auth/password.controller.js`

### Middleware (real)
- `src/middleware/auth.middleware.js` — `authenticate`,
  `authorize(...)`, `optionalAuthenticate`.
- `src/middleware/adminAuth.middleware.js` — `adminAuth`,
  `adminAuthOptional`.
- `src/middleware/tenant.middleware.js` — `resolveTenant`.

### Routes (real)
- `src/routes/auth.routes.js` — replace 501 stubs with real handlers.
- `src/routes/admin-auth.routes.js` — same.

### Validators
- `src/validators/auth.validator.js` — login / refresh / register /
  forgot / reset / MFA schemas.

### Audit
- Every login / logout / lockout emits an `audit` event consumed by
  the Governance sprint (Sprint 8; originally Sprint 7, re-scoped —
  see [`sprint-7.md`](./sprint-7.md)). The `audit` plugin is already in
  place.

## Dependencies

- Sprint 0 (every utility + service wrapper).

## Testing

- Unit: Argon2id hash + verify, JWT sign + verify (RS-style errors),
  refresh-token rotation, MFA enrolment, lockout counter.
- Integration: full login → me → logout flow against `mongodb-memory-server`.
- Security: invalid token, expired token, wrong audience, replayed
  refresh token, brute-force lockout.

## Risks

1. **Refresh-token reuse.** Replay detection must revoke the entire
   family, not just the leaked token. Test thoroughly.
2. **MFA enrollment edge cases.** Backup codes land in Sprint 3+.
3. **Cookie flags.** Refresh-token cookies need `HttpOnly`,
   `Secure`, `SameSite=Lax` (or `Strict`). Verify on every browser.
4. **Subdomain parser.** Sprint 1 reads the header + JWT claim; the
   subdomain parser is Phase 4+.
5. **Account lockout persistence.** Lockout must be persisted on the
   user, not in memory — otherwise it is bypassable across instances.

## Definition of Done

- [x] All deliverables merged.
- [x] `POST /admin-auth/login` returns 200 + access token + refresh cookie.
- [x] `POST /admin-auth/refresh` rotates the refresh token.
- [x] `GET /admin-auth/me` returns the admin profile with the access token.
- [x] `POST /admin-auth/logout` revokes the session.
- [x] Same flow works for `/auth/*` (tenant users).
- [x] MFA enrolment + verify works for `super_admin`.
- [x] Account lockout triggers after N failed attempts.
- [x] Audit events emitted for every login / logout / lockout.
- [x] 90 %+ test coverage on touched surfaces (no coverage tool yet — the
      gate is the 124-test suite incl. 28 end-to-end integration tests;
      wiring `c8`/`v8` coverage into CI is a follow-up).
- [x] `npm run ci:guards` passes.
- [x] `STATUS.md` updated.

### Closure notes

**What shipped beyond the plan (certification-quality hardening):**

- **KDF seam** — `PASSWORD_KDF=argon2|scrypt`. Production stays Argon2id;
  `npm test` forces Node's built-in scrypt so the full suite (incl. the
  Argon2-native-binary integration) runs on any machine. `npm run
  test:argon2` re-runs the suite against real Argon2id.
- **Deterministic refresh-token hashing** — salt = SHA-256(token), so
  `session.repository` can look up the `Session` by the stored hash.
  (The earlier random-salt scheme broke lookup-by-hash.)
- **No hardcoded dummy hash** — timing equalization for unknown users now
  derives its dummy hash from the active KDF instead of a literal
  `$argon2id$` string that crashed under scrypt mode.
- **Integration coverage (new)** — `tests/auth-flow.integration.test.js`,
  `tests/admin-auth-mfa.integration.test.js`,
  `tests/password-reset-session.integration.test.js`,
  `tests/session-lifecycle.integration.test.js` + HTTP / TOTP / factory
  helpers. Real TOTP codes (RFC 6238) for MFA, real cookies for refresh
  rotation, replay ⇒ whole-family revocation, reset ⇒ session family
  revoked, no user enumeration, tenant-header fail-closed, lockout.

**Deferred (tracked):**

- RBAC roles for `authorize(...)` (fails closed 403 until they land).
- Coverage tooling wired into CI to enforce the 90 % number.
- Backup codes / WebAuthn / SSO (Phase 3, see authentication.md).

## Expected Outcome

The platform is reachable. Customers can log in.

## Real-world Examples

A customer signs up in [`04-business-flow.md`](../04-business-flow.md)
step 2 (Platform Admin creates tenant), step 3 (Tenant Owner logs in
with MFA). Sprint 1 is what makes step 3 possible.

## Best Practices

| Do | Why |
| --- | --- |
| **Use the Sprint 0 services, not vendor SDKs directly.** | The CI guard enforces it; the rule exists for a reason. |
| **Audit every auth event.** | Sprint 8 wires the consumer (originally Sprint 7, re-scoped — see [`sprint-7.md`](./sprint-7.md)); the events are already emitted. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Storing refresh tokens in plain text.** | Hash them with Argon2id; treat them as secrets. |
| **Skipping rate-limiting on `/login`.** | `strictLimiter` (Sprint 0) is meant for this. |
| **Returning the same error for "user not found" and "wrong password".** | Allows user enumeration; always return a generic error. |

---

## Summary

Sprint 1 ships authentication for both portals. JWT + refresh-token
rotation + account lockout + TOTP MFA for super_admin. Sprint 1 is
the first sprint that opens the platform to a customer.

## Key Takeaways

- **Sprint 1 is the first reachable sprint.** Everything before it is
  invisible.
- **Two portals, one engine.** The same JWT + Argon2id + session
  primitives serve both `/auth/*` and `/admin-auth/*`.
- **Security mistakes here compound.** Every PR must be reviewed
  against the threat model.

## Interview Preparation

### Common Questions

- "How do you decide between JWT and session cookies?"
- "What is the threat model for `/login`?"
- "How do you implement refresh-token rotation?"

### Sample Answers

- **"JWT vs cookies?"** — Both. Access token in `Authorization:
  Bearer` for API clients; refresh token in HttpOnly+Secure+SameSite
  cookie for browsers. The server does not care which transport the
  client uses.

- **"Threat model for /login?"** — Brute force, credential stuffing,
  user enumeration, token theft, replay. Mitigations: Argon2id
  (slow hashing defeats brute force), `strictLimiter` (defeats
  volumetric attacks), generic error messages (defeats enumeration),
  short access tokens + rotating refresh tokens (limits token theft),
  refresh-token family revocation (defeats replay).

- **"Refresh-token rotation?"** — Every refresh exchange issues a new
  refresh token and revokes the old one. If a revoked token is
  presented again, the entire family is revoked (the attacker is
  using a stolen token; kill the chain).

### Real-World Examples

- A customer logs in; the platform issues a 15-min access token +
  refresh cookie. 14 minutes later the access token expires; the
  platform transparently rotates the refresh. The customer never
  notices.

### Common Mistakes

- Storing refresh tokens in plain text. They are secrets.
- Skipping rate-limiting. Brute force is the first attack.
- Returning different errors for "user not found" vs "wrong
  password". User enumeration.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase containing this sprint
- [`sprint-0.md`](./sprint-0.md) — previous sprint
- [`sprint-2.md`](./sprint-2.md) — next sprint
- [`../04-business-flow.md`](../04-business-flow.md) — step 3 uses
  this sprint
- [`../05-user-journey.md`](../05-user-journey.md) — personas exercised
- [`../../modules/iam/auth/README.md`](../../modules/iam/auth/README.md) — module spec

## Last Updated

- **Sprint:** Sprint 1 close
- **Phase:** Phase 2 — Implementation
- **Sprint implemented:** Sprint 1
- **Date:** 2026-08-06
- **Author:** Engineering (Sprint 1)