# Analivo Phase 3 Security & Operations Report

Date: 2026-10-11

## Executive summary

Phase 3 hardening is implemented without commits, pushes, deployment, or
production database access. The verified connector route-shadowing defect was
fixed, production configuration now fails fast instead of silently selecting
ephemeral infrastructure, a safe readiness probe was added, encryption uses
the dedicated encryption key when configured, and tenant-user MFA claims were
corrected. Google Sheets remains explicitly planned and unwired.

The patched TanStack Start dependency tree remains intact. Frontend production
dependencies are audit-clean. Backend production dependencies have no high or
critical audit findings; two moderate findings remain inside `exceljs`'s nested
legacy `uuid` dependency and are not safely fixable without an incompatible
`exceljs` downgrade. Development-only audit findings remain documented below.

## Findings and disposition

### P1 — Duplicate connector routes — resolved

Evidence: `backend/src/routes/connector.routes.js` registered
`POST /:connectorId/preview` and `POST /:connectorId/sync` twice. Express used
the first CSV handler, so XLSX requests could be parsed or handled by the
wrong provider.

Fix: each public path now has one authenticated route using the generic file
handler. The persisted connector type continues to select CSV/XLSX behavior in
the service layer. `filename` is now passed to generic preview as well.

### P1 — Ephemeral production infrastructure — resolved in application config

Evidence: production previously defaulted to local MongoDB, in-memory Redis/
queues, local storage, a missing encryption key, and no-op mail when settings
were absent.

Fix: production configuration now rejects missing or insecure values for
`JWT_SECRET`, non-local `MONGODB_URI`, `REDIS_URL`, 32+ character
`ENCRYPTION_KEY`, S3 storage and bucket, SMTP host/password, secure cookies,
and non-local CORS/socket origins. Development and test defaults remain
unchanged. The deployment still must supply these values; application code
cannot configure managed infrastructure automatically.

### P1 — Fixable production dependency vulnerabilities — mostly resolved

Targeted compatible upgrades were applied:

- `compression` → `1.8.2`
- `express` → `5.3.0`
- `multer` → `2.4.0`
- `morgan` → `1.12.1`
- `nodemailer` → `10.1.0`
- `socket.io` → `4.8.4`, resolving `engine.io` → `6.6.11`
- frontend `source-map-js` → `1.2.2`

No `npm audit fix --force` was used. TanStack remains:

- `@tanstack/react-start@1.168.60`
- `@tanstack/start-server-core@1.169.39`
- `@tanstack/react-router@1.170.41`
- `@tanstack/router-plugin@1.168.42`

### P1 — Public readiness semantics — resolved

`GET /api/v1/health` remains a cheap liveness endpoint. New
`GET /api/v1/health/ready` returns `200` only when MongoDB is connected and a
safe `503` error envelope otherwise. It does not disclose connection strings,
credentials, or infrastructure details.

### P2 — Tenant-user MFA claim — resolved

Admin TOTP MFA is implemented and tested. Tenant-user MFA is not implemented.
Marketing copy, profile copy, and the frontend architecture prompt now state
that TOTP MFA is admin-only and tenant-user MFA is unavailable. No incomplete
tenant-user MFA implementation was added.

### P2 — Google Sheets status — clarified

The Google Sheets directory contains planning/status documentation only. It is
not registered, exposed, or production-ready. Documentation now labels it as
planned and unwired.

### P2 — Test-runner lifecycle — verified

The Phase 1/2 runner isolation is effective: tests force development mode,
disable external Redis and SMTP, close queue handles, and flush logging. The
full suite completed twice without a hang.

## Dependency audit results

Baseline:

- Backend production audit: 11 vulnerabilities — 5 moderate, 5 high, 1 critical.
- Frontend production audit: 1 high vulnerability (`source-map-js`).

Final:

- Backend all dependencies: 5 vulnerabilities — 2 moderate, 3 high, 0 critical.
- Backend production dependencies (`npm audit --omit=dev`): 2 moderate, 0 high,
  0 critical.
- Frontend all dependencies: 3 vulnerabilities — 1 moderate, 2 critical;
  all are development-only Vitest/tinypool dependency findings.
- Frontend production dependencies (`npm audit --omit=dev`): 0 vulnerabilities.

Remaining findings:

1. Backend `exceljs` resolves a nested vulnerable `uuid` version. npm only
   offers `exceljs@3.4.0` as an audit fix, which is a breaking downgrade from
   `4.4.0`; no override was used to disguise an incompatible dependency.
2. Backend development `nodemon` resolves vulnerable `braces` through its
   watcher chain. npm proposes an incompatible old nodemon downgrade.
3. Frontend development Vitest resolves vulnerable `@vitest/mocker` and
   `tinypool`. npm proposes Vitest 5, a major test-runner upgrade. This is
   deferred for a separately validated tooling migration and does not ship in
   the production bundle.

## Authentication, isolation, and MFA

Existing Phase 1/2 behavior was revalidated through the complete backend suite:

- Admin bootstrap is operator-controlled and idempotent.
- Admin TOTP enrollment, verification, enforcement, and disable flows pass.
- Tenant login, refresh rotation, logout/session revocation, password reset,
  invitation acceptance, expiration, replay, resend, revocation, and concurrent
  acceptance pass.
- Existing tenant isolation and permission tests pass.
- No dangerous TanStack bypass variable exists.

## Production configuration and operations

The application now explicitly requires the following in production:

- Managed MongoDB URI that is not localhost.
- Redis for shared cache/rate limiting and durable BullMQ queues.
- S3-compatible storage and bucket.
- Dedicated encryption key with at least 32 characters.
- SMTP host/password using the supported SMTP transport.
- HTTPS frontend URL and explicit CORS/socket allowlists.
- Secure authentication cookies.

Development and tests intentionally continue using local/in-memory/no-op
drivers. Production operators must provision and monitor the managed services;
the code does not claim that infrastructure exists merely because a driver is
available.

## Files changed

Backend:

- `.env.example`
- `package.json`, `package-lock.json`
- `src/config/env.js`
- `src/controllers/connector.controller.js`
- `src/routes/connector.routes.js`
- `src/routes/health.routes.js`, `src/routes/index.js`
- `src/utils/encryption.js`
- `src/queues/memory.queue.js`
- `src/modules/connectors/README.md`
- `src/modules/connectors/google-sheets/STATUS.md`
- `tests/health.test.js`
- `tests/config/production-config.test.js`

Frontend:

- `package.json`, `package-lock.json`
- `src/routes/index.tsx`
- `src/routes/profile.tsx`
- `src/docs/backend/lovable-master-prompt.md`

Repository-level documentation:

- `docs/PHASE_3_SECURITY_OPERATIONS_PLAN.md`
- `docs/PHASE_3_SECURITY_OPERATIONS_REPORT.md`

## Validation results

Backend focused validation:

- Configuration, health, and connector tests: 11 passed, 0 failed.
- Authentication/MFA/reset/invitation/health/configuration/connector batch:
  23 passed, 0 failed.
- `npm run ci:guards`: passed.

Backend complete validation:

- Run 1 after queue lifecycle hardening: 423 tests passed, 0 failed,
  78.929 seconds.
- Run 2 after queue lifecycle hardening: 423 tests passed, 0 failed,
  84.432 seconds.
- No skipped or cancelled tests were reported.
- A focused invitation run passed 6/6 and left no test worker processes behind.

Frontend:

- `npm test`: 233 tests passed across 23 files.
- `npm run typecheck`: passed.
- `npm run lint`: passed with 9 pre-existing Fast Refresh warnings and 0
  errors.
- `npm run build`: passed; Vercel Nitro output was generated successfully.

## Remaining risks and explicit deferrals

- `exceljs`'s nested `uuid` finding remains a moderate production risk. Avoid
  processing untrusted workbook features beyond the bounded upload/parser path;
  schedule a separately tested ExcelJS upgrade or replacement.
- Development-only nodemon and Vitest findings remain until compatible major
  tooling upgrades are tested.
- Redis/S3/MongoDB/SMTP availability and network policy require deployment-level
  monitoring and credentials. They were not provisioned or tested against
  production infrastructure.
- Tenant-user MFA, backup codes, WebAuthn, SSO, and Google Sheets remain
  explicitly deferred.
- The build emits existing non-fatal bundler warnings about module-level
  `"use client"` directives and the tsconfig-paths plugin.

## Deployment checklist

1. Configure production `MONGODB_URI`, `REDIS_URL`, S3 settings,
   `ENCRYPTION_KEY`, SMTP settings, `JWT_SECRET`, `COOKIE_SECURE=true`,
   `CLIENT_URL`, `CORS_ORIGINS`, and `SOCKET_CORS_ORIGIN`.
2. Run the backend config smoke test in the deployment environment.
3. Confirm Vercel uses `npm ci`, `npm run build`, and the committed frontend
   lockfile.
4. Verify `GET /api/v1/health` for liveness and
   `GET /api/v1/health/ready` for readiness.
5. Confirm a protected endpoint rejects missing credentials and that tenant
   users cannot cross tenant boundaries.
6. Confirm admin TOTP login and tenant login/password reset flows.
7. Review `npm ls` and audit output after the deployment install.

Rollback: redeploy the previous known-good application artifact and restore the
previous dependency lockfiles. Do not roll back by disabling security checks or
setting `DANGEROUSLY_DEPLOY_VULNERABLE_TANSTACK_START_XSS`.

## Suggested commits

Backend:

```text
security: harden production configuration and connector routing
```

Frontend:

```text
security: clarify MFA support and patch frontend audit dependency
```
