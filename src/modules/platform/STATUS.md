# Module — Status

**Sprint:** 0 (foundation) + 5 (Master Data)
**Status:** 🟡 Partial

**Implements:**

- **Master Data (Sprint 5 — ✅ Implemented):** global reference catalogue
  (`src/models/MasterData.js`, `src/services/masterData.service.js`,
  `src/routes/master-data.routes.js`) — admin write, public cached read.
  See `platform/master-data/STATUS.md`.

**Still fail-closed stubs (501):**

- `/settings/*`, `/feature-flags/*` — the engines already ship inside
  Sprint 3 (`setting.service.js`, `featureFlag.service.js`, wired through
  the `/tenants/*` surface); the standalone surfaces remain stubs.
- `/notifications/*`, `/email-templates/*` — Sprint 5 plan deferred.

**Depends on:** Sprint 0 (cache), Sprint 3 (settings/flags engines),
Sprint 2 (admin RBAC).