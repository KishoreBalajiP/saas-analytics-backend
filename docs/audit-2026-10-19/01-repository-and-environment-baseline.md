# 01. Repository and environment baseline

This document records what was audited: the exact checkouts, how each repository is structured and built, how configuration is loaded, and what the existing build and test scripts returned on the audit machine. It is factual and contains no recommendations; those live in documents 19 and 20.

## 1. Checkouts audited

| | Backend | Frontend |
|---|---|---|
| Local path | `/Users/josephremingstonl/Downloads/code/saas-analytics-backend` | `/Users/josephremingstonl/Downloads/code/saas-analytics-frontend` |
| Remote | `git@github.com:KishoreBalajiP/saas-analytics-backend.git` | `git@github.com:KishoreBalajiP/saas-analytics-frontend.git` |
| Branch | `main` (tracks `origin/main`; no other local or remote branches) | `main` (same) |
| HEAD | `d030515 gaps docs` (2026-10-16 00:22 +0530) | `434dbb8 fix(ux): improve homepage navigation and product truthfulness` (2026-10-15 20:12 +0530) |
| Commits on `main` | 30 | 25 |
| Working tree at start | clean, no staged or unstaged changes | clean |
| Working tree at end | only `docs/audit-2026-10-19/` added | unchanged |
| Brand | Repository and `APP_NAME` default say "SaaS Analytics Platform"; user-facing brand "Analivo" appears in the frontend (`frontend/src/routes/index.tsx:29`, `Brand` component) and in recent commit messages | "Analivo" in UI; package name `saas-analytics-frontend` |

**Deployed-source parity is unverified.** Nothing in either repository pins which commit is running on Render (`saas-analytics-backend-ffao.onrender.com`) or Vercel (`analivo.vercel.app`). There is no `render.yaml`, no deploy workflow, and no version endpoint that reports a commit SHA (`GET /api/v1/health` and `/health/ready` report `APP_VERSION`, which defaults to `package.json` `1.0.0`; `backend/src/routes/health.routes.js:36-52`). See OPS findings in document 12.

The assignment brief refers to `D:\saas-analytics-platform\backend` and `\frontend`. Older reports in `backend/docs/` were produced against that Windows layout. Paths in this audit are written `backend/...` and `frontend/...`.

## 2. Backend repository

### 2.1 Stack (installed versions from `npm ci`)

Node ESM (`"type": "module"`, `engines.node >= 20`). Express 5.3.0, Mongoose 8.24.2 (driver 7.5.0), Socket.IO 4.8.4 with optional `@socket.io/redis-adapter`, `jose` 6.2.8 (HS256 JWT), `argon2` 0.45.1 with a scrypt fallback, `otplib` 13.4.1 (TOTP), BullMQ 6.0.7 / ioredis 6.0.0 (optional), node-cron 4.6.0, nodemailer 10.1.0, Razorpay SDK 2.9.8, `@aws-sdk/client-s3` 3.1102.0, `csv-parse` 7.0.2, `exceljs` 4.4.0, `multer` 2.4.0, `helmet` 8.3.0, `express-rate-limit` 7.5.1, Pino 9.14.0 + Morgan. Dev: `mongodb-memory-server`, `nodemon`. No linter, formatter or type checker is configured for the backend.

### 2.2 Layout

| Path | Contents | Count |
|---|---|---|
| `src/server.js` | Process entry: HTTP server, Socket.IO, DB connect with retry/degraded mode, connector consumer, scheduler, graceful shutdown | 1 |
| `src/app.js` | Express assembly: request id, access log, helmet, custom CSP, compression, CORS, cookie/body parsers (raw body for `/webhooks` and `/billing/webhook`), Morgan, global rate limiter, routes, 404, error handler. Also registers the analytics and export queue workers and the audit consumer at import time | 1 |
| `src/routes/` | 35 routers mounted under `API_PREFIX` (default `/api/v1`) by `src/routes/index.js` | ≈235 `router.<verb>(` registrations |
| `src/controllers/`, `src/modules/iam/auth/*.controller.js` | HTTP handlers | 30 + 3 |
| `src/services/`, `src/modules/iam/auth/*.service.js` | Business logic and infrastructure wrappers (cache, queue, storage, email, payment provider) | 51 + 4 |
| `src/repositories/` | Mongoose data access | 34 |
| `src/models/` | Mongoose schemas plus five shared plugins (`tenantScope`, `softDelete`, `paginate`, `optimisticConcurrency`, `audit`) | 41 models |
| `src/middleware/` | auth, adminAuth, apiKeyAuth, tenant resolution, tenant isolation, RBAC/permission, validation, idempotency, rate limit, upload, audit, access log, compliance, error | 19 |
| `src/connectors/`, `src/modules/connectors/` | Connector framework and providers (csv, xlsx, mongodb, webhook; google-sheets is docs only) | |
| `src/queues/`, `src/jobs/` | Memory/BullMQ queue transports; node-cron scheduler and 7 registered jobs plus workers | |
| `src/docs/` | Engineering handbook, ADR-001..010, phase and sprint plans, `STATUS.md` | |
| `tests/` | `node --test` suites, helpers for in-memory MongoDB, auth, factories, TOTP | 67 files, 561 test declarations |
| `scripts/ci/` | Test runner, five CI guard scripts, admin bootstrap script | 9 |
| `docs/` | ~31 historical audit/phase/readiness reports (pre-dating this audit) | |
| Root | `Dockerfile` (multi-stage, node:22-alpine, non-root user, healthcheck on `/api/v1/health`), `docker-compose.yml` (mongo:7 + app), `.env.example`, `AI_CONTEXT.md`, `CHANGELOG.md`, four ≈810 KB UTF-16 test-output `.txt` files tracked in git | |

### 2.3 Configuration

All environment access is centralised in `backend/src/config/env.js` (enforced by the `check-config` CI guard). `.env.example` documents about 100 keys; no `.env` exists on the audit machine and none is tracked. Key groups (names only):

| Group | Keys |
|---|---|
| Runtime | `NODE_ENV`, `PORT`, `APP_NAME`, `APP_VERSION`, `API_PREFIX`, `REQUEST_BODY_LIMIT`, `SHUTDOWN_TIMEOUT_MS`, `TRUST_PROXY`, `LOG_LEVEL`, `LOG_REDACT` |
| Database | `MONGODB_URI`, `MONGODB_CONNECT_ATTEMPTS`, `MONGODB_RETRY_DELAY_MS`, `MONGODB_MAX_POOL_SIZE`, `MONGODB_MIN_POOL_SIZE`, `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `MONGODB_CONNECT_TIMEOUT_MS` |
| Web/CORS | `CORS_ORIGINS`, `CLIENT_URL`, `SOCKET_CORS_ORIGIN`, `SOCKET_*` |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `AUTH_COOKIE_NAME`, `AUTH_COOKIE_SAMESITE`, `COOKIE_SECURE`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS`, `PASSWORD_RESET_TTL_MS`, `PASSWORD_RESET_TOKEN_LENGTH`, `EMAIL_VERIFICATION_TTL_MS`, `EMAIL_VERIFICATION_RESEND_COOLDOWN_MS`, `MFA_ISSUER`, `PASSWORD_KDF` |
| Rate limits | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_STRICT_MAX`, `EXTERNAL_API_RATE_LIMIT_*`, `EMBED_RATE_LIMIT_*` |
| API keys / embed | `API_KEY_TTL_DAYS`, `API_KEY_MAX_PER_TENANT`, `EMBED_TOKEN_DEFAULT_TTL_SEC`, `EMBED_TOKEN_MAX_TTL_SEC`, `EMBED_MAX_PER_DASHBOARD`, `EMBED_CORS_ALLOW_ALL` |
| Infrastructure | `REDIS_URL`, `STORAGE_PROVIDER`, `STORAGE_BASE_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `ENCRYPTION_KEY`, `ENCRYPTION_ALGORITHM`, `ENCRYPTION_KEY_VERSION` |
| Mail | `MAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` |
| Billing | `RAZORPAY_ENABLED`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_ENVIRONMENT`, `RAZORPAY_PLAN_MAPPING_JSON` |
| Jobs | `SCHEDULER_ENABLED`, `SCHEDULER_TIMEZONE`, `JOB_{SHEET_SYNC,EMAIL,CLEANUP,ANOMALY,BILLING_RECONCILE}_{CRON,ENABLED}` |
| Connectors | `CONNECTOR_CSV_MAX_UPLOAD_MB`, `CONNECTOR_XLSX_MAX_UPLOAD_MB`, `MONGODB_CONNECTOR_*`, `CONNECTOR_QUEUE_*`, `WEBHOOK_TOLERANCE_SECONDS`, `CONNECTOR_ENCRYPTION_PURPOSE` |
| Support / retention | `SUPPORT_IMPERSONATION_DAILY_CAP`, `SUPPORT_IMPERSONATION_TOKEN_TTL`, `RETENTION_{AUDIT_LOG,ACCESS_LOG,LOGIN_ATTEMPT,SESSION,IDEMPOTENCY,EXPORT}_DAYS` |

Production start-up gates (`backend/src/config/env.js:366-407`) refuse to boot unless `JWT_SECRET`, `MONGODB_URI`, `REDIS_URL`, `ENCRYPTION_KEY` (≥ 32 chars), `STORAGE_PROVIDER=s3` + `S3_BUCKET`, SMTP host and password, `COOKIE_SECURE=true`, a non-localhost `CLIENT_URL`, and non-wildcard `CORS_ORIGINS`/`SOCKET_CORS_ORIGIN` are set; Razorpay completeness is checked only when enabled. Some keys are parsed but never used by application code: `CONNECTOR_QUEUE_*` (hard-coded in `connector.queue.js`) and `ENCRYPTION_KEY_VERSION`/`ENCRYPTION_ALGORITHM` (no reader outside `env.js`); see document 12.

Defaults worth noting because they apply whenever the deployment does not override them: `EMBED_CORS_ALLOW_ALL=true` (`env.js:214`), `SCHEDULER_ENABLED=true` (`env.js:259`), all of `JOB_{SHEET_SYNC,EMAIL,CLEANUP,ANOMALY,BILLING_RECONCILE}_ENABLED=false` (`env.js:309-330`), `RAZORPAY_ENABLED=false` (`env.js:264`), `AUTH_COOKIE_SAMESITE=None` in production (`env.js:170`), `TRUST_PROXY=1` (`env.js:137`), and `autoIndex` disabled in production (`backend/src/config/database.js:30`).

### 2.4 Build, run and deploy

- `npm start` → `node src/server.js`; `npm run dev` → nodemon.
- `npm test` → `scripts/ci/run-tests.js` (isolation overrides described in document 21).
- `npm run ci:guards` → five static guards (stub allowlist, every route has an auth guard or exemption comment, every model imports a plugin, no `process.env` outside config, README/STATUS presence).
- `npm run bootstrap:admin` → creates the first platform super administrator (not executed).
- Docker: `Dockerfile` builds a production image that excludes `tests/` and `docs/` via `.dockerignore`. No Render blueprint or CI/CD file is present. `backend/docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` describes a manual Render deployment.

## 3. Frontend repository

### 3.1 Stack (installed versions)

React 19.3.0, TanStack Start 1.168.60 with TanStack Router 1.170.41 (file-based routes, SSR) and TanStack Query 5.103.2, Vite 8.3.0 via `@lovable.dev/vite-tanstack-config`, Nitro 3 beta with the `vercel` preset, TypeScript 5.9.3, Tailwind 4.3.3, Radix UI primitives (shadcn-style `components/ui`), Recharts 2.15.4, react-hook-form + zod 3.25.76, Vitest 3.2.7 with jsdom and Testing Library. ESLint 9 + Prettier configured.

The project is connected to Lovable (`frontend/AGENTS.md`): commits to `main` sync back to the Lovable editor, and rewriting published history must be avoided.

### 3.2 Layout

| Path | Contents |
|---|---|
| `src/routes/` | 50 route files plus a README. Public: `/`, `/login` (+ `/login/forgot`, `/login/reset`), `/register`, `/request-access`, `/invite/accept`, policy pages (`/privacy`, `/terms`, `/cookies`, `/acceptable-use`). Tenant: `/dashboard`, `/onboarding`, `/datasets`, `/datasets/$connectorId`, `/analytics`, `/dashboards` (+ detail/edit), `/reports` (+ detail/edit), `/alerts` (+ detail/edit), `/api-keys`, `/embed`, `/billing`, `/notifications`, `/profile`, `/security`, `/settings`. Admin: `/admin/login`, `/admin/dashboard`, `/admin/tenants` (+ detail), `/admin/admins`, `/admin/roles`, `/admin/access-requests`, `/admin/audit-logs`, `/admin/access-logs`, `/admin/compliance`, `/admin/monitoring`, `/admin/plans`, `/admin/subscriptions`, `/admin/entitlements`, `/admin/support` |
| `src/features/<area>/{api,components}` | Feature API clients and views for admin, alerts, analytics, api-keys, auth, billing, dashboards, datasets, embed, notifications, reports |
| `src/lib/api/client.ts` | Fetch wrapper: in-memory access tokens per audience, HttpOnly refresh cookie, one refresh-and-retry, idempotency key on non-GET, `X-Tenant-Id` only on login/password calls |
| `src/lib/auth/session.tsx` | Tenant and admin session providers; tenant slug remembered in `localStorage` |
| `src/lib/permissions/` | Permission string helpers (UX gating only; backend is authoritative) |
| `src/lib/errors/` | SSR/client error capture and a Lovable error reporter |
| `src/docs/backend/` | `frontend-api-contract.md` and `lovable-master-prompt.md` (the original generation brief) |
| `src/routes-tests/`, `**/*.test.ts(x)` | 27 Vitest files |

### 3.3 Configuration and deploy

`.env.example` documents `VITE_API_BASE_URL`, `VITE_API_PREFIX`, `VITE_RAZORPAY_KEY_ID` (a publishable key id, not a secret). `vercel.json` sets `npm ci` / `npm run build`, output `.output`, region `iad1`. `VERCEL.md` says the output directory is `.vercel/output` and the install command is `npm install`, which disagrees with `vercel.json`; the build on the audit machine produced `.vercel/output/nitro.json`. When `VITE_API_BASE_URL` is unset in a production build the client falls back to `window.location.origin` (`frontend/src/lib/api/client.ts:6-10`).

## 4. Baseline command results

Full commands, outputs and interpretation are in `21-verification-log.md`.

| Repo | Check | Result |
|---|---|---|
| backend | `npm ci` | exit 0 |
| backend | `npm run ci:guards` | 5/5 OK |
| backend | `npm test` | 561 tests, **560 pass, 1 fail** (`self-service-registration.integration.test.js:205`, concurrent same-slug registration returned 201 twice) |
| backend | `npm audit --omit=dev` | 2 moderate: `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq) via `exceljs`; the only offered fix is a semver-major downgrade of `exceljs` to 3.4.0 |
| frontend | `npm ci` | exit 0 |
| frontend | `npm run typecheck` | pass |
| frontend | `npm run lint` | 0 errors, 9 warnings |
| frontend | `npm test` | 244 tests, **242 pass, 2 fail** (`storeTenantSlug` localStorage tests; Node 26 native Web Storage) |
| frontend | `npm run build` | pass |
| frontend | `npm audit --omit=dev` | 0 vulnerabilities |

Earlier reports state "561 passing" (backend) and "244 passing" (frontend). Those counts are not reproducible on the audit machine's Node v26.7.0, and there is no CI in either repository to establish which Node version is authoritative. Document 17 discusses the test-count discrepancies in the older status documents (367, 405, 533 and 561 have all been quoted).

## 5. What this baseline does not establish

- That production runs these commits, or with which environment values.
- That SMTP, S3, Redis, Razorpay or any external MongoDB source works.
- Browser behaviour, accessibility, or responsive layout (no E2E harness exists; source was read instead).
- Load, performance or recovery characteristics.

Each of these is listed as a verification step with an owner and acceptance criterion in `20-implementation-roadmap.md`.
