# ADR-002: Use Argon2id for Password Hashing

**Status:** Accepted
**Date:** 2026-08-05

## Context

OWASP 2024 recommends Argon2id for new systems. The team has used
`bcrypt` historically.

## Decision

Use the `argon2` npm package with OWASP default parameters
(`memoryCost: 19 MiB, timeCost: 2, parallelism: 1`).

## Consequences

**Easier:**

- Memory-hard; brute-force resistance scales with hardware, not
  just CPU cycles.
- OWASP-recommended.
- `needsRehash()` lets us transparently upgrade older hashes on
  successful login.
- Single algorithm; `bcrypt` had cost-factor parameter drift.

**Harder:**

- Slower than `bcrypt` (~150-300 ms on modern hardware) — this is
  the point: brute force is slower.
- Higher memory footprint per hash verification.
- Parameter tuning is in one file (`utils/password.js`).

## Implementation

- `src/utils/password.js` is the only consumer.
- Empty plaintext throws; empty hash returns `false` (not throws).

## Related

- [`authentication.md`](../backend/authentication.md)