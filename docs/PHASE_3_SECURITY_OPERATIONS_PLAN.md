# Analivo Phase 3 Security & Operations Plan

This plan is based on the repository state inspected on 2026-10-11. The
backend and frontend worktrees were clean before this phase. Phase 1 and Phase
2 behavior is present in the committed codebase.

## Verified findings

| Severity | Finding | Evidence | Planned disposition |
| --- | --- | --- | --- |
| P1 | Duplicate connector `preview` and `sync` registrations shadow the generic file handlers. | `backend/src/routes/connector.routes.js:53-56` registers the same paths twice; the first CSV handler wins for XLSX requests. | Consolidate each public path to one authenticated generic handler while preserving CSV/XLSX provider dispatch. Add route regression coverage. |
| P1 | Production can silently run with local storage, in-memory queues/cache, default/local MongoDB, or empty encryption key. | `backend/src/config/env.js:115-226`, `backend/src/services/storage.service.js:56-70`, `backend/src/queues/index.js:42-49`. | Fail fast for production deployment configuration that would lose durability or weaken shared controls. Keep development/test defaults. Add configuration tests and documentation. |
| P1 | Public health endpoint reports `200` while the database is disconnected and exposes environment/version details. | `backend/src/routes/health.routes.js:25-45`. | Preserve a cheap liveness endpoint and add a dependency-aware readiness endpoint with a safe response. Do not expose connection details. |
| P2 | Frontend copy implies tenant-user MFA is available although only admin TOTP is implemented. | `frontend/src/routes/index.tsx:228`, `frontend/src/routes/profile.tsx:33-66`; admin TOTP is implemented under `backend/src/modules/iam/auth/mfa.service.js`. | Correct claims to distinguish admin MFA from unsupported tenant-user MFA; add an explicit support matrix to the report. |
| P1 | Production dependency audit currently reports exploitable backend packages. | `npm audit --omit=dev`: compression, multer, nodemailer, engine.io, proxy-addr, brace-expansion and related transitive packages. | Apply compatible targeted patches, regenerate the lockfile, and validate the resolved tree. Do not use `--force`. |
| P2 | Frontend production audit reports `source-map-js` high severity. | `npm audit --omit=dev`: `source-map-js` 1.0.0–1.2.1. | Apply the compatible non-major patch and re-audit. |
| P2 | Full test runner needs repeatability verification after the Phase 1/2 lifecycle fixes. | Baseline run completed with 420 tests; the runner uses isolated Redis/mail settings in `backend/scripts/ci/run-tests.js`. | Run the complete suite twice with timeouts and record counts/runtime. Fix only reproducible lifecycle failures. |
| P2 | Production mail configuration can resolve to a no-op transport when SMTP is absent. | `backend/src/services/mail.transport.js:26-40`; production validation only checks password when a host exists. | Require a configured supported mail transport in production; preserve no-op behavior in development/test. |

## Already fixed or not reproducible

- TanStack Start is already patched: `@tanstack/react-start@1.168.60` and
  `@tanstack/start-server-core@1.169.39`; no bypass variable is configured.
- Admin bootstrap is operator-controlled and does not create an unauthenticated
  endpoint.
- Password reset and tenant invitation tokens are opaque, hashed at rest,
  expiring, and tested for replay/concurrency behavior.
- Backend authorization and tenant isolation are enforced server-side in the
  inspected routes and existing regression suite.
- Google Sheets is documented as deferred and is not advertised as a shipped
  connector. Email templates and monitoring details remain explicit 501/deferred
  surfaces rather than being represented as complete features.

## Compatibility and migration considerations

- Development and test environments retain local MongoDB, in-memory queue/cache,
  local storage, and no-op mail defaults.
- Production configuration validation may prevent a process from starting until
  MongoDB, Redis, S3-compatible storage, encryption, frontend origins, and mail
  are configured. This is intentional and requires deployment environment
  updates before rollout.
- Connector paths and response contracts remain unchanged.
- Dependency changes are limited to compatible patched releases and their lockfile
  resolutions.

## Acceptance criteria

- No duplicate connector route path remains for preview or sync.
- CSV and XLSX preview/sync retain their current provider behavior and permission
  checks.
- Production fails fast instead of silently selecting an ephemeral infrastructure
  fallback.
- Liveness/readiness semantics are distinguishable and do not disclose secrets.
- Tenant-user MFA is not marketed as available until implemented.
- Production dependency audit has no fixable critical/high vulnerabilities in the
  shipped dependency set, or each remaining item has a documented blocker and
  mitigation.
- Backend full tests pass twice, CI guards pass, and all frontend checks pass.

## Test cases

- Connector route selection, unauthenticated access, missing permissions, CSV,
  XLSX, invalid file type, and oversized upload.
- Production configuration rejection for missing MongoDB/Redis/S3/encryption/mail
  values, while development/test defaults continue to boot.
- Liveness always responds without infrastructure details; readiness reports a
  dependency failure safely.
- Existing authentication, tenant isolation, invitation, reset-token, MFA, and
  session-revocation suites remain green.
- Two complete backend runs finish without open handles or external service use.

## Manual infrastructure requirements

Vercel must use the committed frontend lockfile and `npm ci`. The production
backend deployment must provide a managed MongoDB, Redis, S3-compatible bucket,
encryption key, HTTPS frontend origin allowlists, secure cookies, and a supported
SMTP configuration. These are deployment responsibilities and are not changed
automatically by this phase.
