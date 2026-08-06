# ADR-005: S3-Compatible Storage Abstraction

**Status:** Accepted
**Date:** 2026-08-05

## Context

Production deployments store files in object storage (AWS S3 or
S3-compatible: MinIO, R2). Local dev uses the filesystem. The
business logic must not couple to a vendor SDK.

## Decision

`services/storage.service.js` is the only public interface; the
provider is selected via `STORAGE_PROVIDER` (`local` or `s3`).

## Consequences

**Easier:**

- Feature code never imports `@aws-sdk/client-s3`.
- Switching from MinIO to AWS is a config change.
- Local driver has path-traversal protection built in.
- Presigned URLs work for both providers (S3 in prod; pseudo-URL
  in dev).

**Harder:**

- Two drivers to maintain.
- Pseudo-URLs in dev are not real signed URLs (acceptable for dev).

## Implementation

- `src/storage/localStorage.js` — filesystem driver with
  path-traversal protection.
- `src/storage/s3Storage.js` — `@aws-sdk/client-s3` driver.
- `src/services/storage.service.js` — public interface.

## Related

- [`storage.md`](../backend/storage.md)