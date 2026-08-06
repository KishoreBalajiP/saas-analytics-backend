# Backend — Storage Layer

> **WHAT this is:** the deep-dive on the storage layer (local
> filesystem + S3).
> **WHY it exists:** CSV uploads, exported reports and embed
> artefacts are files. Provider-agnostic so we can run in dev on
> disk.
> **HOW to use it:** read *Architecture*; never import `@aws-sdk/*`
> from feature code.
> **WHEN to update it:** as the storage layer evolves.
> **WHERE it lives:** `src/docs/backend/storage.md`.

---

## Purpose

> **WHAT this is:** the deep-dive on the storage layer.
> **WHY it exists:** CSV uploads, exports and embed artefacts are
> files.
> **HOW to use it:** read *Architecture*; never import `@aws-sdk/*`.
> **WHEN to update it:** as the storage layer evolves.
> **WHERE it lives:** `src/docs/backend/storage.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 6 / 9 implementer** | Has the contract. |
| **Operator** | Has the S3 selection rules. |

## Current Status

> **Status:** `Implemented (Sprint 0)`.
> **Sprint:** Sprint 0.
> **Owner:** Engineering team.

## Business Perspective

CSV uploads land in storage. Exported reports land in storage.
Embed artefacts (signed-token images) live in storage. Cold archival
of audit / access logs is the Phase 3 use case.

## Technical Perspective

Local filesystem in dev; S3 (or S3-compatible: MinIO, R2) in
production. Same driver surface: `put`, `get`, `delete`, `exists`,
`list`, `createWriteStream`, `presignedUrl`, `close`. Selected by
env (`STORAGE_PROVIDER`).

The public service is `services/storage.service.js`. It applies the
`storage/` prefix.

## Architecture

```
                ┌──────────────────────┐
                │  Feature code         │
                └──────────┬───────────┘
                           │ services/storage.service.js
                           ▼
                ┌──────────────────────┐
                │  Storage facade       │
                │  put / get / list     │
                └──────────┬───────────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
   ┌────────────────────┐       ┌────────────────────┐
   │  fs/promises        │       │  @aws-sdk/client-s3 │
   │  (dev / tests)      │       │  (production)       │
   └────────────────────┘       └────────────────────┘
```

## Driver Surface

| Method | Returns |
| --- | --- |
| `put(key, data, options)` | `Promise<{ key, size }>` |
| `get(key)` | `Promise<Buffer>` |
| `delete(key)` | `Promise<void>` |
| `exists(key)` | `Promise<boolean>` |
| `list(prefix, options)` | `Promise<string[]>` |
| `createWriteStream(key)` | `Promise<WritableStream>` |
| `presignedUrl(key, options)` | `Promise<string>` |
| `close()` | `Promise<void>` |

## Key Conventions

- `<connectorId>/<kind>/<file>` for connector artefacts.
- `<tenantId>/reports/<runId>.csv` for report outputs.
- `embed/<tokenHash>` for embed artefacts.
- Path traversal is rejected by the local driver.

## Real-world Examples

### Upload a CSV

```js
import { put } from '../services/storage.service.js';

await put('connectors/csv/' + connectorId + '/sample.csv', buffer, {
  contentType: 'text/csv',
});
```

### Stream a report

```js
import { createWriteStream } from '../services/storage.service.js';

const stream = await createWriteStream('reports/' + runId + '.csv');
stream.write(headerLine);
for await (const row of rows) stream.write(row);
stream.end();
```

### Generate a presigned URL for browser download

```js
import { presignedUrl } from '../services/storage.service.js';

const url = await presignedUrl('reports/' + runId + '.csv', {
  ttlSec: 600, // 10 min
});
res.redirect(url);
```

## Best Practices

| Do | Why |
| --- | --- |
| **Use the `storage/` prefix-free public service.** | Feature code never imports the driver. |
| **Stream large files.** | Memory pressure. |
| **Presigned URLs for browser access.** | Bytes do not pass through the API. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Importing `@aws-sdk/*` from feature code.** | Provider switching becomes a refactor. |
| **Loading a 10 GB report in memory.** | OOM. |

## Future Work

| Item | Phase |
| --- | --- |
| **Cold archival of audit / access logs** | Phase 3 |
| **Per-region buckets for data residency** | Phase 4 |

---

## Summary

The storage layer has two drivers (local + S3) and one public
service (`services/storage.service.js`). Feature code never imports
`@aws-sdk/*`. Keys follow `<scope>/<kind>/<file>` conventions.

## Key Takeaways

- **Provider-agnostic.** Local in dev, S3 in prod.
- **Stream large files.**
- **Presigned URLs for browser access.**

## Related Documents

- [`../../services/storage.service.js`](../../../src/services/storage.service.js) — facade
- [`../DECISIONS.md`](../DECISIONS.md) — ADR-005

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)