# Models Layer

**Mongoose schemas/models.**

Sprint 1 ships the first implemented models: `User`, `Admin`, `Tenant`,
`Session`, `LoginAttempt`. Every other file under this directory remains
an architecture placeholder (no schema) until its sprint lands.

Conventions for every model:

- One model per file: `src/models/<entity>.js`.
- Export schema **and** model; schemas can be reused/embedded.
- Timestamps: `{ timestamps: true }` everywhere.
- Multi-tenancy: every tenant-owned schema includes `tenantId` and
  registers the `tenantScope` plugin so a tenant filter is enforced
  automatically. Platform-scoped models (`Admin`, `Tenant`) deliberately
  omit it.
- Plugin set: `softDelete`, `paginate`, `optimisticConcurrency`, `audit`.
  `Session` and `LoginAttempt` apply a deliberate subset (see their file
  headers) because their lifecycle is TTL/append-only, not soft-delete.
- Add TTL indexes for expiring data (sessions) and lean indexes for hot
  queries - plan indexes at schema creation time.
- Never store secrets in plain text: passwords use Argon2id
  (`utils/password.js`), refresh tokens are hashed, MFA secrets are
  encrypted.
