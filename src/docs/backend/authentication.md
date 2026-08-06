# Backend — Authentication

> **WHAT this is:** the deep-dive on JWT, sessions, MFA and refresh-
> token rotation.
> **WHY it exists:** authentication is the first user-visible feature
> and the highest-risk surface. Documenting it once is cheaper than
> re-explaining it forever.
> **HOW to use it:** read *Architecture* before implementing;
> re-read *Security* before merging.
> **WHEN to update it:** as the auth surface evolves.
> **WHERE it lives:** `src/docs/backend/authentication.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on authentication.
> **WHY it exists:** authentication is the first user-visible feature
> and the highest-risk surface.
> **HOW to use it:** read *Architecture* before implementing;
> re-read *Security* before merging.
> **WHEN to update it:** as the auth surface evolves.
> **WHERE it lives:** `src/docs/backend/authentication.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 1 implementer** | Has the full plan. |
| **Security reviewer** | Has the threat model. |
| **Frontend engineer** | Has the contract. |

## Current Status

> **Status:** `Planned` — Sprint 0 ships the JWT / password utilities;
> Sprint 1 ships the real handlers.
> **Sprint:** Sprint 1.
> **Owner:** Engineering team.

## Business Perspective

Sprint 1 ships the first reachable surface: a customer can sign up
(Sprint 2 invitation), log in, refresh their session, log out and
reset their password. Super admins can enrol TOTP MFA.

## Technical Perspective

JWT access tokens (15 min, `aud: 'user' | 'admin'`) via
[`utils/jwt.js`](../../../src/utils/jwt.js). Argon2id password hashing
via [`utils/password.js`](../../../src/utils/password.js). Refresh
tokens are opaque 256-bit, Argon2id-hashed at rest in `Session`.
Account lockout persisted on the user. TOTP MFA via `otplib` for
`super_admin`.

## Architecture

```
                ┌────────────────────────┐
                │        Browser          │
                │  /auth/* + /admin-auth/*│
                └────────────┬───────────┘
                             │ Authorization: Bearer <access>
                             │ Cookie: <refresh>  HttpOnly Secure SameSite=Lax
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  Express                                                       │
│   authenticate / adminAuth  ──▶  utils/jwt#verify             │
│                                   { aud, iss, exp }            │
│                                   on failure → 401            │
└─────────────────┬──────────────────────────────────────────────┘
                  │ req.actor = { id, email, roles, tenantScope }
                  ▼
┌────────────────────────────────────────────────────────────────┐
│  Services                                                      │
│   auth.service        ──▶  Argon2id verify + cache              │
│   session.service     ──▶  rotateSession / revokeSession       │
│   mfa.service         ──▶  TOTP enrol / verify                 │
└─────────────────┬──────────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────────────────────────┐
│  Mongoose                                                      │
│   User / Admin / Tenant / Session / LoginAttempt               │
│   tenantScope · softDelete · optimisticConcurrency · audit     │
└────────────────────────────────────────────────────────────────┘
```

## Real-world Examples

### Login flow

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "alex@acme.com", "password": "<plaintext>" }
```

1. Server reads the user by email.
2. Argon2id verify. On failure: increment `LoginAttempt`,
   possibly lock the account.
3. On success: create `Session`, sign access JWT (15 min), set
   refresh cookie (HttpOnly + Secure + SameSite=Lax).
4. Audit row: `module: 'iam.auth', action: 'login', result:
   'success'`.

Response:

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "accessToken": "<jwt>",
    "expiresIn": 900,
    "user": { "id": "usr_01H...", "email": "alex@acme.com", "roles": ["tenant_owner"] }
  }
}
```

### Refresh-token rotation

```http
POST /api/v1/auth/refresh
Cookie: refresh=<opaque>
```

1. Server hashes the opaque token, looks up `Session` by hash.
2. If the session is revoked → 401 (replay detected).
3. If the session is valid → revoke the old session, create a new
   one, sign a new access token, set a new refresh cookie.
4. Audit row: `module: 'iam.auth', action: 'refresh'`.

### TOTP enrolment (super_admin)

```http
POST /api/v1/admin-auth/mfa/enroll
Authorization: Bearer <admin-access>
```

1. Server generates a TOTP secret + otpauth URL.
2. Stores the secret hashed on the `Admin` record (pending = true).
3. Returns a QR code (data URL).

```http
POST /api/v1/admin-auth/mfa/verify
Authorization: Bearer <admin-access>
{ "code": "123456" }
```

1. Server verifies the TOTP code against the stored secret.
2. On success: marks `mfaEnrolled = true`.
3. Future logins require the TOTP code.

## Best Practices

| Do | Why |
| --- | --- |
| **Hash refresh tokens at rest** (Argon2id). | The DB breach does not leak valid sessions. |
| **Generic error messages** on login (no user enumeration). | "Invalid credentials" covers both "user not found" and "wrong password". |
| **Strict rate limit on `/login` and `/refresh`.** | Brute force is the first attack. |
| **Refresh-token family revocation** on replay. | If a leaked token is presented, kill the entire chain. |
| **`HttpOnly`, `Secure`, `SameSite=Lax`** on the refresh cookie. | Cookies are the easiest attack vector. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Storing refresh tokens in plain text.** | The DB breach leaks valid sessions. |
| **Returning "user not found" vs "wrong password" as different errors.** | User enumeration. |
| **Skipping the lockout counter.** | Brute force is free. |
| **Allowing refresh-token replay without family revocation.** | Stolen tokens become forever-valid. |

## Security — Threat Model

| Threat | Mitigation |
| --- | --- |
| **Brute force** | `strictLimiter` + persisted account lockout |
| **Credential stuffing** | Argon2id (slow) + lockout + rate limit |
| **User enumeration** | Generic error messages + constant-time compare |
| **Token theft** | Short access TTL (15 min) + rotating refresh + family revocation |
| **Replay** | Refresh-token rotation + family revocation |
| **XSS / cookie theft** | `HttpOnly`, `Secure`, `SameSite=Lax` cookies; no JS access |
| **CSRF** | SameSite=Lax on refresh cookie; access token in `Authorization` header |
| **MFA bypass** | Required for `super_admin`; not yet for other admins (Phase 3) |

## Future Work

| Item | Phase |
| --- | --- |
| **Backup codes for MFA** | Phase 3 |
| **WebAuthn / passkey** | Phase 3 |
| **OAuth / OIDC / SAML SSO** | Phase 3 |
| **SCIM 2.0 provisioning** | Phase 3 |
| **Multi-region session replication** | Phase 4 |

---

## Summary

Authentication uses JWT access tokens (15 min) + opaque refresh
tokens (rotating, hashed at rest) + Argon2id password hashing +
TOTP MFA for super admins. Account lockout is persisted on the
user. Sprint 1 ships it for both portals.

## Key Takeaways

- **Two portals, one engine.** The same JWT + Argon2id + session
  primitives serve both `/auth/*` and `/admin-auth/*`.
- **Refresh-token rotation is the primary defence** against token
  theft.
- **MFA is mandatory for super_admin.**

## Interview Preparation

### Common Questions

- "How do you implement refresh-token rotation?"
- "What is the threat model for `/login`?"

### Sample Answers

- **"Refresh-token rotation?"** — Every refresh exchange issues a
  new refresh token and revokes the old one. If a revoked token is
  presented again, the entire family is revoked. The DB never
  stores the plaintext refresh token; only the Argon2id hash.

- **"Threat model?"** — Brute force (rate limit + lockout),
  credential stuffing (Argon2id), enumeration (generic errors),
  token theft (short access TTL + rotating refresh), replay
  (family revocation), XSS / cookie theft (HttpOnly + Secure +
  SameSite cookies), CSRF (SameSite + bearer access token).

### Real-World Examples

- A customer logs in; the platform issues a 15-min access token +
  refresh cookie. 14 min later the access token expires; the
  platform transparently rotates the refresh. The customer never
  notices.

### Common Mistakes

- Plain-text refresh tokens. DB breach leaks sessions.
- Different error messages for "user not found" vs "wrong password".
  Enumeration.
- Skipping the lockout counter. Brute force is free.

## Related Documents

- [`../03-product-roadmap.md`](../03-product-roadmap.md) — when this ships
- [`../04-business-flow.md`](../04-business-flow.md) — step 3 uses auth
- [`../phases/sprint-1.md`](../phases/sprint-1.md) — sprint plan
- [`../../modules/iam/auth/README.md`](../../modules/iam/auth/README.md) — module spec
- [`../../utils/jwt.js`](../../../src/utils/jwt.js) — JWT utilities
- [`../../utils/password.js`](../../../src/utils/password.js) — Argon2id utilities
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-001 (jose), ADR-002 (Argon2id)

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 1
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)