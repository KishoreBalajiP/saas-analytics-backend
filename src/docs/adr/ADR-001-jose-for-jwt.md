# ADR-001: Use `jose` for JWT

**Status:** Accepted
**Date:** 2026-08-05

## Context

The platform needs a JWT library for access tokens, refresh
challenge tokens, internal service tokens and MFA challenges. The
team has used `jsonwebtoken` historically.

## Decision

Use `jose` (`npm:jose`) instead of `jsonwebtoken`.

## Consequences

**Easier:**

- Modern Promise-based API (no callback juggling).
- JWE/JWS support out of the box (we may want encrypted JWTs for
  internal service tokens).
- Algorithm agility via the `algorithms` array on `jwtVerify`.
- Key rotation via `createRemoteJWKSet` when we introduce a JWKS
  endpoint (Phase 4+).
- ESM-friendly; `jsonwebtoken` is CommonJS-only.
- Maintained by a security-focused maintainer (panva).

**Harder:**

- Slightly larger transitive dependency tree.
- Different error shapes than `jsonwebtoken` (we wrap them in a
  typed `JwtError`).
- Team familiarity — addressed in onboarding (`utils/jwt.test.js`
  covers the surface).

## Implementation

- `src/utils/jwt.js` is the only consumer.
- Audience + issuer are typed enums (`JWT_AUDIENCES`, `JWT_ISSUERS`).
- `JwtError` carries codes: `EXPIRED`, `INVALID`, `INVALID_SIGNATURE`.

## Related

- [`../backend/authentication.md`](../backend/authentication.md)