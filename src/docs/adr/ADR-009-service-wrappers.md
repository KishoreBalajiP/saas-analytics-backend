# ADR-009: Service-Wrapper Abstraction for Infrastructure

**Status:** Accepted
**Date:** 2026-08-05

## Context

Feature code must not import infrastructure libraries (`ioredis`,
`bullmq`, `@aws-sdk/client-s3`, `nodemailer`). Switching providers
must be a one-file change.

## Decision

Every infrastructure layer has a `src/services/<x>.service.js`
wrapper exposing a stable, typed surface. Feature code imports only
from `src/services/`.

## Consequences

**Easier:**

- Switching providers (BullMQ → SQS, S3 → R2, SMTP → SES) is a
  single-file change in the wrapper.
- Unit tests can swap the driver via dependency injection in the
  wrapper.
- Lint-friendly: feature code never imports the vendor SDKs.

**Harder:**

- Discipline to keep feature code in the wrapper boundary.
- The wrapper itself must remain stable; any breaking change is a
  Versioned API bump.

## Implementation

- `src/services/cache.service.js`
- `src/services/queue.service.js`
- `src/services/storage.service.js`
- `src/services/email.service.js`
- `src/services/mail.transport.js` (the SMTP / noop factory).

## Related

- [`../backend/`](../backend/) — concern deep-dives