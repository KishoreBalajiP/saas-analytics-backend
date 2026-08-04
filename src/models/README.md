# Models Layer

**Mongoose schemas/models.**

No models exist yet by design - Phase 1 is infrastructure only.

When models are added, follow these conventions:

- One model per file: `src/models/<entity>.model.js` (or inside a feature
  module under `src/modules/<feature>/`).
- Export schema **and** model; schemas can be reused/embedded.
- Timestamps: `{ timestamps: true }` everywhere.
- Multi-tenancy: every tenant-owned schema includes `tenantId` and is
  registered through a shared base-schema helper so a tenant filter is
  enforced automatically.
- Add TTL indexes for expiring data (sessions, tokens) and lean indexes for
  hot queries - plan indexes at schema creation time.
- Never store secrets in plain text: use `utils/crypto.js` encryption.
