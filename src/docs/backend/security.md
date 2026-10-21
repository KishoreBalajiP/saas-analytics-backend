# Backend — Security

> **WHAT this is:** the platform's threat model and the controls that
> mitigate each threat.
> **WHY it exists:** security must be designed, not bolted on.
> **HOW to use it:** read *Threat Model* before merging any PR that
> touches auth, RBAC, isolation or secrets.
> **WHEN to update it:** as the threat surface evolves.
> **WHERE it lives:** `src/docs/backend/security.md`.

---

## Purpose

> **WHAT this is:** the platform's threat model.
> **WHY it exists:** security must be designed, not bolted on.
> **HOW to use it:** read *Threat Model* before merging.
> **WHEN to update it:** as the threat surface evolves.
> **WHERE it lives:** `src/docs/backend/security.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Security reviewer** | Has the threat model + controls. |
| **Tech lead** | Has the risk register. |

## Current Status

> **Status:** `Implemented` — Sprint 0 ships the primitives; Sprints
> 1–7 harden the surface.
> **Sprint:** Always (continuous).
> **Owner:** Founding architect + Engineering team.

## Threat Model

| Threat | Surface | Mitigation | Owning Sprint |
| --- | --- | --- | --- |
| Brute force | `/login`, `/refresh` | Per-route limiters (IP + account) + persisted account lockout that decays after the window | Sprint 1 / 1.9 |
| Credential stuffing | `/login` | Argon2id (slow) + lockout + rate limit | Sprint 1 |
| User enumeration | `/login` | Generic error messages | Sprint 1 |
| Token theft | access + refresh | Short access TTL (15 min) + rotating refresh + family revocation | Sprint 1 |
| Token replay | refresh | Family revocation on reuse; a lagging duplicate within `AUTH_REFRESH_REUSE_GRACE_MS` (10 s) of the rotation, one hop only, gets an access token for the live successor and no new cookie | Sprint 1 / 1.9 |
| XSS / cookie theft | refresh cookie | HttpOnly + Secure + SameSite; the refresh token and session id are never in a response body; per-portal cookie name + path | Sprint 1 / 1.9 |
| Stale access after suspension | access token | Account and tenant status re-checked on every authenticated request and socket handshake | 1.9 |
| Endless session | refresh | Absolute lifetime (`AUTH_SESSION_ABSOLUTE_TTL`) enforced at refresh regardless of rotation | 1.9 |
| CSRF | refresh cookie + access token | SameSite=Lax + bearer access token | Sprint 1 |
| MFA bypass | `/login` | TOTP required for `super_admin` | Sprint 1 |
| Cross-tenant access | every business endpoint | `resolveTenant` + `tenantIsolation` + `tenantScope` plugin | Sprints 1–2 |
| Privilege escalation | every business endpoint | RBAC + cache invalidation on write | Sprint 3 |
| Stale permission cache | RBAC | TTL (5 min) + invalidation hook | Sprint 3 |
| Webhook spoofing | `/webhooks/*` | HMAC-SHA256 signature with constant-time compare | Sprint 6 |
| Webhook replay | `/webhooks/*` | Idempotency keys + replay window | Sprint 6 |
| CSV OOM | `/connectors/csv` | Stream-parse with backpressure | Sprint 6 |
| Secret leak at rest | connector `config`, refresh tokens | `utils/encryption.js` AES-256-GCM envelope | Sprint 0 |
| Secret leak in logs | Pino logs | Redaction paths in `config/env.js` | Sprint 0 |
| Response body leak | access log | Capture size only, never body | Sprint 8 (originally Sprint 7; re-scoped — see `phases/sprint-7.md`) |
| Audit-log gap | every mutation | `audit` plugin emits on every save | Sprint 0 + Sprint 8 (consumer that persists `AuditLog` rows was originally Sprint 7; re-scoped — see `phases/sprint-7.md`) |
| Hash-chain tamper | audit log | Sequential IDs in MVP; hash-chain in Phase 3 | Phase 3 |
| Impersonation abuse | `/support/*` | Mandatory reason + daily cap + double log | Sprint 8 |
| Impersonation abuse (roadmap 2.3) | `/support/*`, `/workspace/support-access`, `/support-session` | Diagnostics first; workspace consent or four-eyes break-glass required; read-only support sessions (unsafe methods 403 `IMPERSONATION_READ_ONLY`), time-boxed (<= 60 min, no refresh); operator id (`impersonatedBy`) on every access-log and audit row; atomic per-admin daily cap; tenant-visible grants, sessions and activity | Roadmap 2.3 |

## Controls Catalogue

### Encryption
- **Algorithm:** AES-256-GCM via `utils/encryption.js`.
- **Key derivation:** context-scoped (SHA-256 hash of `{tenantId,
  purpose}` salted with the master secret).
- **Master secret:** `JWT_SECRET` (Phase 1/2); `ENCRYPTION_KEY`
  preferred in production (Sprint 0); KMS in Phase 3+.
- **Envelope:** `enc:v1:<ctxHash>:<iv>:<tag>:<ciphertext>`.

### Password hashing
- **Algorithm:** Argon2id (`argon2` npm package).
- **Parameters:** `memoryCost: 19 MiB, timeCost: 2, parallelism: 1`
  (OWASP 2024 baseline).
- **Rehash detection:** `needsRehash()` upgrades older hashes on
  successful login.

### JWT
- **Library:** `jose`.
- **Algorithm:** HS256 (default); RS256/ES256 when a public/private
  key pair is introduced.
- **Audience:** `user` / `admin`.
- **Issuer:** `saas-analytics`.
- **TTL:** 15 min access; opaque 256-bit refresh, hashed at rest.

### Multi-tenancy
- **Three layers:** `resolveTenant`, `tenantIsolation`,
  `tenantScope` plugin.
- **JWT claim is the truth**; the `X-Tenant-Id` header is a hint
  that must reconcile.

### RBAC
- **Permission key shape:** `<module>.<action>`.
- **Cache key:** `iam:rbac:<scope>` (5 min TTL).
- **Default deny.**
- **System roles immutable.**

### Audit + access logs
- **Audit:** `audit` plugin emits on every save; Sprint 8 consumer
  persists `AuditLog` rows (originally Sprint 7 — re-scoped; see
  `phases/sprint-7.md`).
- **Access:** middleware captures status + size, never body.
- **Sensitive fields:** stripped before persistence.

### Rate limiting
- **Global:** `apiLimiter` (300/15min per IP).
- **Auth (per portal, one bucket per route class, `AUTH_RATE_LIMIT_*`):**
  login 10/15min per IP + account and 50/15min per IP; refresh 120/15min
  per IP + session cookie; password forgot 5 per IP + account, reset 5 per
  IP;
  registration 10, email verify/resend 5 per IP; invitation preview/accept
  20 per IP; admin MFA 10 per admin. Counters are shared through Redis
  when `REDIS_URL` is set (`rate-limit-redis`), in memory otherwise. A
  limit returns 429 `RATE_LIMITED` with `Retry-After`.
- **Per-account:** lockout after N failed attempts; the counter restarts
  once the lockout window has passed.
- **Trust proxy:** limits key on `req.ip`; set `TRUST_PROXY` to the real
  number of proxy hops or `X-Forwarded-For` can be spoofed.

### Headers
- `helmet()` for the standard set.
- `X-Tenant-Id`, `X-Idempotency-Key`, `X-Request-Id` exposed in
  CORS.
- `X-Idempotent-Replay: true` on cached idempotency responses. Every
  authenticated POST/PUT/PATCH/DELETE with `X-Idempotency-Key` is
  replay-safe: keys are scoped by actor + tenant + method + path, only 2xx
  outcomes are stored (24 h, encrypted), a different body with the same
  key is 422 `IDEMPOTENCY_KEY_REUSED`, and a concurrent duplicate on
  another instance is 409 `IDEMPOTENCY_IN_PROGRESS`.

## Best Practices

| Do | Why |
| --- | --- |
| **Default deny.** | Every route mounts auth + permission explicitly. |
| **Validate the JWT against the tenant header.** | The header is a hint, not the truth. |
| **Redact before persistence.** | Logs and audit tables leak secrets if you forget. |
| **Sign webhooks with constant-time compare.** | Timing attacks are real. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Logging response bodies.** | They contain tenant data. |
| **Returning different errors for "user not found" vs "wrong password".** | User enumeration. |
| **JSON-parsing the webhook route.** | Breaks signature verification. |
| **Storing refresh tokens in plain text.** | DB breach leaks sessions. |

## Future Work

| Item | Phase |
| --- | --- |
| **KMS-managed keys** | Phase 3 |
| **WebAuthn / passkey** | Phase 3 |
| **Hash-chain audit** | Phase 3 |
| **SIEM forwarder** | Phase 3 |
| **Per-region encryption contexts** | Phase 4 |

---

## Summary

The platform's threat model is documented; every threat has a
mitigation; every mitigation lives in the code or a CI guard.

## Key Takeaways

- **Default deny.** Every route mounts auth + permission.
- **JWT claim is the truth.**
- **Redact before persistence.**

## Interview Preparation

### Common Questions

- "What is your threat model?"
- "How do you prevent cross-tenant access?"

### Sample Answers

- **"Threat model?"** — Brute force, credential stuffing, user
  enumeration, token theft, replay, XSS / cookie theft, CSRF, MFA
  bypass, cross-tenant access, privilege escalation, webhook
  spoofing, secret leak at rest and in logs. Each has a documented
  mitigation in the code or a CI guard.

- **"Cross-tenant?"** — Three layers: `resolveTenant`,
  `tenantIsolation`, `tenantScope` plugin.

## Related Documents

- [`authentication.md`](./authentication.md) — auth deep-dive
- [`rbac.md`](./rbac.md) — RBAC deep-dive
- [`multi-tenancy.md`](./multi-tenancy.md) — multi-tenancy deep-dive
- [`connectors.md`](./connectors.md) — connector security (signatures)
- [`../DECISIONS.md`](../DECISIONS.md) — security ADRs

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)