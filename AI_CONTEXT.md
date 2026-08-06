# AI_CONTEXT.md

> **Project briefing for AI assistants (OpenCode, ChatGPT, Claude, Gemini, Copilot).**
> Read this file first, then [STATUS.md](src/docs/STATUS.md),
> before making any code change. This is a briefing, not documentation — point
> to the handbook, do not duplicate it.

---

## 1. Project Summary

**Project:** SaaS Analytics Platform
**Repository:** `saas-analytics-backend` (single Node.js service)

A **multi-tenant SaaS analytics platform**: every customer company gets an
isolated workspace (tenant), connects its own data sources, builds dashboards,
shares reports and embeds widgets externally — while the platform operator
(us) governs every tenant from a single admin console.

It exposes four surfaces on one backend:

- **Tenant Portal API** — `/auth/*`, `/tenants/*`, `/dashboards/*`, `/reports/*`
- **Admin Portal API** — `/admin-auth/*`, `/admin/admins/*`, `/monitoring/*`, `/support/*`
- **Public embed surface** — `/embed/*` (signed widgets)
- **Connector surface** — `/connectors/*`, `/webhooks/*` (data ingestion)

**Primary purpose:** fill the gap between single-tenant BI tools (Tableau,
Looker) and shared single-instance tools (Metabase, Redash) — isolated
workspaces *and* central operator governance, with strong isolation, a
connector framework and embeds designed together.

**Target users:** mid-market analytics buyers (50–2 000 employees, 5–50
dashboard users) and SaaS companies that embed analytics for their own
customers. Enterprise single-tenant deployments are an anti-persona until
Phase 4+.

**Status convention** used everywhere: `Implemented` / `Partial` /
`Stub (fail-closed)` / `Planned` / `Future`. Never paraphrase these labels.

---

## 2. Current Status

| Field | Value |
| --- | --- |
| Current version | `1.0.0` |
| Current phase | Phase 2 — Implementation |
| Current sprint | Sprint 1 — Authentication (closing) |
| Next sprint | Sprint 2 (planned) |
| Current progress | ~35 % of Phase 2 |
| Last completed milestone | Sprint 1 close — auth for both portals: login/refresh/logout, password reset, TOTP MFA, lockout (124 tests, 5/5 CI guards green) |
| Next milestone | RBAC roles for `authorize(...)` + first post-auth feature sprint |

Facts as of Sprint 1 close:

- Auth is fully shipped and integration-tested against `mongodb-memory-server`
  for both portals (`/auth/*` + `/admin-auth/*`): login → me → logout, refresh
  rotation with replay ⇒ whole-family revocation, MFA enrolment/verify with
  real TOTP codes, password reset with no enumeration and session-family
  revocation, account lockout.
- `PASSWORD_KDF` seam: Argon2id in production; `npm test` forces Node's
  built-in scrypt (portable, no native binary); `npm run test:argon2` runs the
  real Argon2id KDF. Refresh tokens are hashed deterministically (salt =
  SHA-256 of the token) so session lookup-by-hash works.
- `npm test` → 124 pass, 0 fail. `npm run ci:guards` → 5/5 green. `npm audit` → 0 vulnerabilities.
- `authorize(...)` still fails closed (403) until RBAC roles land.

See [STATUS.md](src/docs/STATUS.md) for the canonical,
daily-read state and the full shipped/stubbed/planned inventory.

---

## 3. Architecture Summary

See [ARCHITECTURE.md](src/docs/ARCHITECTURE.md) for the
system diagram and request lifecycle. High level:

**Layered architecture** (strict dependency direction, no layer imports a
layer above it): thin `controllers` → `services` → `repositories` → `models`,
with per-route `middleware` and feature code grouped under `src/modules/<feature>/`.

- **Controllers** — parse input, call one service, return the envelope.
- **Services** — own business logic, throw `ApiError` factories, call
  `cache/queue/storage/email` service wrappers. Never know HTTP or Mongoose.
- **Repositories** — own Mongoose queries, return plain objects (`.lean()`),
  apply tenant scoping; never throw HTTP errors.
- **Models** — schemas + hooks; apply the shared plugin set (`tenantScope`,
  `softDelete`, `paginate`, `optimisticConcurrency`, `audit`).

**Repository Pattern** — data access is isolated behind a stable API in
`src/repositories/` (or `src/modules/<feature>/<feature>.repository.js`).

**Service Layer** — business logic lives in `src/modules/<feature>/<feature>.service.js`;
controllers never touch repositories or models directly.

**Multi-tenant** — three layers of defence: `resolveTenant` middleware,
`tenantIsolation` middleware, and the `tenantScope` Mongoose plugin. Trust the
JWT, not the `X-Tenant-Id` header.

**Dynamic RBAC** — roles are data, not code. Permissions are
`<module>.<action>` strings; the resolved set is cached at `iam:rbac:<scope>`
(5-min TTL, invalidated on write). Default deny. Planned for Sprint 3.

**Connector architecture** — `BaseConnector` contract (`connect`, `validate`,
`preview`, `ingest`, `disconnect`) + `ConnectorRegistry`. Business code never
imports a vendor SDK. Framework implemented; first providers (CSV, Webhook)
planned for Sprint 6.

**Infrastructure abstraction** — feature code only consumes service wrappers
(`cache.service.js`, `queue.service.js`, `storage.service.js`,
`email.service.js`); never `ioredis`, `bullmq`, `@aws-sdk/client-s3`,
`nodemailer`. Provider is selected by environment config, never hard-coded.

---

## 4. Tech Stack

| Concern | Choice |
| --- | --- |
| Backend runtime | Node.js 20 LTS, ES modules (`"type": "module"`) |
| Framework | Express 5 |
| Database | MongoDB + Mongoose 8 |
| Realtime | Socket.IO 4 (Redis adapter when `REDIS_URL` set) |
| Authentication | JWT via `jose` (HS256), Argon2id password hashing, refresh-token rotation, TOTP MFA |
| Cache | In-memory (default) or Redis (`ioredis`) |
| Queue | In-memory (default) or BullMQ on Redis |
| Storage | Local filesystem or S3 (`@aws-sdk/client-s3`) |
| Encryption | AES-256-GCM via `src/utils/encryption.js` |
| Email | `nodemailer` (SMTP / noop) |
| Logging | Pino (+ Morgan) |
| Scheduler | node-cron |
| Deployment | Render / Railway / Docker / AWS ECS — config-only, no platform logic in source |
| Testing | `node --test`, `mongodb-memory-server` for integration |
| CI | Five guardrails under `scripts/ci/`, wired to `npm run ci:guards` |
| Documentation | `src/docs/` engineering handbook + per-module `README.md` / `STATUS.md` |

See [repo-root README.md](README.md) for the full stack
table and script list.

---

## 5. Coding Rules

The load-bearing rules (enforced by CI or mandatory by docs):

- **Never read `process.env` outside `src/config/env.js`.** Config flows
  through `env.js`; CI guard `ci:check-config` blocks violations.
- **Never bypass the Service Layer.** Controllers and services call the public
  service wrappers for infrastructure; repositories own all data access.
- **Never access the database directly from controllers.** Go through
  repositories.
- **Never import vendor SDKs from feature code** (`ioredis`, `bullmq`,
  `@aws-sdk/client-s3`, `nodemailer`). Use the service wrappers.
- **Every route mounts auth middleware** (`authenticate` / `adminAuth` /
  `optionalAuthenticate`) or an explicit `ci:routes-exempt` annotation.
- **Every Mongoose model applies at least one shared plugin.**
- **Every request is validated** with `validateRequest(schema)` — bad input is
  `422`, not `500`.
- **Every `POST` is idempotency-safe** (`X-Idempotency-Key`).
- **Throw `ApiError` factories only**; never raw `new Error(...)` or raw errors
  to clients; the global `errorHandler` formats every response envelope.
- **Fail closed.** Unimplemented security middleware returns `501`, never
  silently allows traffic.
- **ES modules only** — no CommonJS, no `require()`. Node 20+.
- **Log with `req.log` (Pino), never `console.log`; never log secrets.**
- **Documentation ships with code.** Behaviour-changing PRs update the matching
  docs, `STATUS.md` and `CHANGELOG.md` in the same commit.
- **CI guards + tests must pass locally** before merge.

Full details: [coding-standards.md](src/docs/development/coding-standards.md),
[api-standards.md](src/docs/development/api-standards.md),
[definition-of-done.md](src/docs/development/definition-of-done.md).

---

## 6. Documentation Map

All links below are relative to this repository root (`saas-analytics-backend/`).
Start with the handbook home and STATUS:

- [README.md](README.md) — public home, tech stack, architecture rules
- [CHANGELOG.md](CHANGELOG.md) — chronological log
- [src/docs/README.md](src/docs/README.md) — engineering handbook index
- [src/docs/STATUS.md](src/docs/STATUS.md) — **single source of truth for project state**
- [src/docs/ARCHITECTURE.md](src/docs/ARCHITECTURE.md) — system diagram + request lifecycle
- [src/docs/DECISIONS.md](src/docs/DECISIONS.md) — all 10 ADRs (ADR-001 → ADR-010)
- [src/docs/errors.md](src/docs/errors.md) — error envelope contract
- [src/docs/TEMPLATE.md](src/docs/TEMPLATE.md) — mandatory doc template

Foundational docs:

- [01-getting-started.md](src/docs/01-getting-started.md) — onboarding + quick start
- [02-project-vision.md](src/docs/02-project-vision.md) — why we exist, target customers
- [03-product-roadmap.md](src/docs/03-product-roadmap.md) — phases + priorities
- [04-business-flow.md](src/docs/04-business-flow.md) — onboarding story
- [05-user-journey.md](src/docs/05-user-journey.md) — personas and limits

Backend deep dives (`src/docs/backend/`):

- [authentication.md](src/docs/backend/authentication.md)
- [rbac.md](src/docs/backend/rbac.md) — dynamic roles/permissions
- [multi-tenancy.md](src/docs/backend/multi-tenancy.md) — three isolation layers
- [connectors.md](src/docs/backend/connectors.md) — `BaseConnector` framework
- [database.md](src/docs/backend/database.md), [queues.md](src/docs/backend/queues.md),
  [cache.md](src/docs/backend/cache.md), [storage.md](src/docs/backend/storage.md),
  [security.md](src/docs/backend/security.md), [monitoring.md](src/docs/backend/monitoring.md),
  [websockets.md](src/docs/backend/websockets.md)

Development (`src/docs/development/`):

- [coding-standards.md](src/docs/development/coding-standards.md)
- [api-standards.md](src/docs/development/api-standards.md)
- [testing-strategy.md](src/docs/development/testing-strategy.md)
- [definition-of-done.md](src/docs/development/definition-of-done.md)
- [documentation-rules.md](src/docs/development/documentation-rules.md)
- [deployment.md](src/docs/development/deployment.md)
- [environment-setup.md](src/docs/development/environment-setup.md)

Planning and code references:

- [src/docs/phases/README.md](src/docs/phases/README.md) — phase + sprint index
- [src/docs/phases/sprint-1.md](src/docs/phases/sprint-1.md) — next sprint plan
- [src/docs/adr/README.md](src/docs/adr/README.md) — how to read/add ADRs
- [src/docs/glossary/README.md](src/docs/glossary/README.md) — plain-English terms
- [src/modules/README.md](src/modules/README.md) — feature module map
- [src/models/plugins/README.md](src/models/plugins/README.md) — plugin usage
- [src/connectors/README.md](src/connectors/README.md) — connector framework
- [scripts/ci/](scripts/ci/) — the guardrail scripts

Per-module `README.md` + `STATUS.md` files exist under `src/modules/<feature>/`
and are the contract + status for each module.

---

## 7. Current Priorities

The last work was **Sprint 1 — Authentication** (closed). Both portals are
live and integration-tested: `/auth/*` for tenant users and `/admin-auth/*`
for platform admins, JWT access tokens (15 min) + rotating refresh tokens,
account lockout, TOTP MFA for `super_admin`, real `authenticate` /
`adminAuth` / `resolveTenant` middleware, rate-limited login, refresh-token
family revocation on replay, and password reset that revokes the session
family.

Sprint 1 closure state:

1. `POST /admin-auth/login` → access token + refresh cookie ✅
2. `POST /admin-auth/refresh` → rotated refresh token ✅
3. `GET /admin-auth/me` → admin profile ✅
4. `POST /admin-auth/logout` → revoke session ✅
5. The same flow for `/auth/*` ✅
6. MFA enrolment + verify with real TOTP codes ✅
7. Account lockout after N failures ✅
8. KDF seam (`PASSWORD_KDF=argon2|scrypt`) + deterministic refresh-token
   hashing (salt = SHA-256(token)) ✅

Models added: `User`, `Admin`, `Tenant`, `Session`, `LoginAttempt` (all with
the shared plugin set). Suite is 124 tests (scrypt mode), green; run the
real KDF with `npm run test:argon2`.

**Next up: Sprint 2 — IAM** (tenant / admin / user lifecycle CRUD), then
Sprint 3 (RBAC roles for `authorize(...)`, which currently fails closed).
See [sprint-2.md](src/docs/phases/sprint-2.md). Do not start later sprints
(connectors, analytics, governance) — they are planned, not open.

---

## 8. Things AI Must Never Do

- **Do not invent architecture.** Docs describe the code, not aspirations; if
  they disagree, the code is right and the doc must be fixed.
- **Do not bypass existing layers** — never query Mongoose from controllers,
  never touch repositories/models from middleware or routes.
- **Do not import vendor SDKs in feature code** — the service wrappers are the
  only public infrastructure interface.
- **Do not read `process.env` outside `src/config/env.js`** — the CI guard will
  fail the build.
- **Do not create Mongoose models without the shared plugin set.**
- **Do not add routes without auth middleware** (or an explicit exemption).
- **Do not replace a fail-closed stub silently** — replacing a stub means
  implementing its sprint; keep the `501` fail-closed behaviour until then.
- **Do not remove or weaken existing abstractions, plugins or guardrails.**
- **Do not mark `Planned`/`Future` work as shipped** — use the exact status
  labels (`Implemented` / `Partial` / `Stub (fail-closed)` / `Planned` / `Future`).
- **Do not rewrite approved documentation.** Update it only when the code
  change makes it true — in the same commit as the code.
- **Do not duplicate documentation.** Point to existing docs instead of
  restating them.
- **Do not bypass ADRs.** Preserve architectural decisions unless explicitly
  instructed otherwise; a new decision needs a new ADR.
- **Do not add code comments that paraphrase code.** Comment the *why*.

---

## 9. Working Instructions

When given a coding request:

1. **Read `AI_CONTEXT.md`** (this file).
2. **Read [STATUS.md](src/docs/STATUS.md)** — confirm what
   is shipped, stubbed, planned, and which sprint is active.
3. **Read the relevant documentation** — sprint plan (`src/docs/phases/sprint-N.md`),
   the matching backend deep-dive, and the owning module `README.md`.
4. **Verify against the current implementation** — the code is the authority;
   docs are a map, not a guarantee.
5. **Implement changes** following the architecture, coding rules, and status
   labels above.
6. **Run verification** — `npm test` and `npm run ci:guards` must pass locally
   before finishing.
7. **Update documentation if required** — `STATUS.md`, `CHANGELOG.md`, module
   READMEs, and any affected doc change in the same commit as the code.
8. **Never commit unless explicitly asked.**

---
