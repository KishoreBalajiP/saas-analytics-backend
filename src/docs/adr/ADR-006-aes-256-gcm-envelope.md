# ADR-006: AES-256-GCM with Versioned Envelope for At-Rest Encryption

**Status:** Accepted
**Date:** 2026-08-05

## Context

Connector credentials (Atlas connection strings, OAuth tokens,
webhook signing secrets, third-party API keys) need encryption at
rest. The previous state had `utils/crypto.js#encryptSecret` reusing
`JWT_SECRET` as the key-derivation seed, coupling auth secrets with
data-at-rest secrets.

## Decision

`utils/encryption.js` uses AES-256-GCM with a context-scoped key
(SHA-256 hash of `{tenantId, purpose}` salted with the master
secret). The envelope is `enc:v1:<ctxHash>:<iv>:<tag>:<ciphertext>`.

## Consequences

**Easier:**

- A leak of the master secret alone is insufficient to decrypt any
  stored value (the context is required).
- KMS swap is a future version bump (`enc:v2:...`).
- `rotateKeys()` is a placeholder returning `{ rotated: 0 }` until
  the KMS slot is implemented (Phase 4+).
- `ENCRYPTION_KEY` is separate from `JWT_SECRET` so rotating one
  does not invalidate the other.

**Harder:**

- Migration story when the envelope version bumps.
- `rotateKeys()` is a placeholder today; deferred work.

## Implementation

- `src/utils/encryption.js` — the envelope + AES-256-GCM.
- `src/utils/crypto.js` — low-level primitives; still kept for
  backward compatibility.
- `src/config/env.js` — `encryption.key`, `encryption.algorithm`,
  `encryption.keyVersion`.

## Related

- [`security.md`](../backend/security.md)