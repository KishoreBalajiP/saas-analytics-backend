# Storage - architecture

File storage abstraction. **Architecture only - no implementation in
Phase 1.1.**

## Why storage

- Connector uploads (CSV files), analytics exports and generated assets are
  files. Where they physically live (local disk vs S3) is a *deployment*
  decision that must not leak into business logic.
- Switching providers (dev disk -> S3, or MinIO -> AWS S3) should be a config
  change, not a refactor.

## The `StorageDriver` contract

Every provider returns a driver with the same method surface (defined in
`localStorage.js` / `s3Storage.js`):

| Method              | Responsibility                                        |
| ------------------- | ----------------------------------------------------- |
| `put(key, data)`    | store a buffer/stream under a key                     |
| `get(key)`          | read a stored object as a Buffer                      |
| `delete(key)`       | remove an object                                      |
| `exists(key)`       | check presence without downloading                    |
| `list(prefix)`      | list object keys under a prefix                       |
| `createWriteStream(key)` | stream a large object to storage                 |
| `presignedUrl(key)` | short-lived URL for browser uploads/downloads         |

Keys follow `connectorId/<kind>/<file>` conventions so S3 prefix-based
lifecycle policies work out of the box.

## Providers

| Provider   | Factory               | Config (future)                                    |
| ---------- | --------------------- | -------------------------------------------------- |
| local      | `createLocalStorage`  | `baseDir` (defaults to `uploads/`)                 |
| s3         | `createS3Storage`     | `bucket`, `region`, `endpoint`, credentials        |

Selection via config only:

```js
import { createStorage, STORAGE_PROVIDERS } from '../storage/index.js';

const storage = createStorage({ provider: STORAGE_PROVIDERS.S3, bucket: 'my-bucket' });
```

## Integration points

- `src/modules/connectors/csv/` - uploaded CSV files
- `src/modules/connectors/` - exports and sync artifacts
- `src/jobs/*` - queue workers write/read exports through this abstraction

## Status

Phase 1.1 ships the facade + provider stubs (fail closed). No SDK is
installed. When S3 lands, only `@aws-sdk/client-s3` is added and only this
folder changes.
