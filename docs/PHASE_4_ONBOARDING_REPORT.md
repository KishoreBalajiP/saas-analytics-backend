# Analivo Phase 4 — Onboarding Completion and Release Audit

Date: 2026-10-12

## Outcome

The self-service onboarding journey is complete and verified in the project's
isolated integration environment. The earlier Phase 4 plan refers to this
customer workflow; it is separate from the enterprise roadmap in
`backend/src/docs/phases/phase-4.md`.

The test creates a fresh owner and tenant, captures the verification email,
verifies the token, signs in, creates and validates a CSV connector, previews a
real uploaded CSV, processes the queued sync through the test worker, confirms
two persisted rows, creates and reads a dashboard, invites a Viewer, logs out,
and signs back in. The reopened tenant records reconstruct the connector and
dashboard progress. Frontend route tests cover signup/verification states,
onboarding resume/error states, and dashboard setup state. This is an isolated
HTTP and component-test verification, not a live browser session against
production email infrastructure.

## Implemented Behavior

- Public registration creates a pending tenant and unverified owner. A
  SHA-256-digested, expiring, single-use email token verifies the owner and
  provisions the tenant before activation. Duplicate slug races return a
  conflict; concurrent verification has one token consumer; restricted tenants
  are not reactivated.
- Existing shared tenant authentication and session handling are retained.
  Unverified owners cannot log in or reach protected tenant APIs. Existing
  password recovery, invitation acceptance, and separate admin login routes
  remain in place.
- The guided importer uses supported CSV/XLSX file connectors only. It calls
  the connector validate, preview, sync, detail/status, and row-list APIs. A
  `202 Accepted` is not shown as success; sync completion requires persisted
  successful worker status and rows. The server stores queued/running/succeeded/
  failed status and suppresses duplicate in-flight sync requests.
- Existing tenant-scoped connector/dashboard records reconstruct setup after
  refresh or a new login. Connector/dashboard creation checks current server
  records before retrying. Team invitation is optional; its owner-authorized
  API derives tenant identity from the authenticated session, defaults to
  Viewer, and reuses a pending invite on retry.
- Failure, loading, empty, retry, completion, and skip states are covered in
  the onboarding UI. Signup CTAs point to `/register`; invitation acceptance
  remains at `/invite/accept`. Google Sheets is not advertised as a supported
  onboarding source.

## Security and Isolation

The isolated regressions cover token expiry/replay, concurrent registration and
verification, suspended-tenant protection, owner assignment, blocked
pre-verification login, unauthenticated protected access, tenant-header
forgery, idempotent invitations, and existing invitation acceptance/resend
behavior. Tenant-scoped connectors, rows, and dashboards use the existing
authenticated APIs and their tenant/RBAC middleware; the integration verifies
cross-tenant invitation manipulation is rejected. No onboarding authority or
connector secrets are stored in browser storage.

Provisioning remains retryable while the tenant is pending; activation uses a
pending-state compare-and-set after owner/role/settings/flag initialization.
Concurrent initialization seed operations use idempotent/atomic repository
updates. A provisioning failure may leave pending seed records for a retry, but
does not make the tenant active prematurely.

## Changed Files

Backend changes preserve existing services and extend them for this flow:

- Auth/verification: `src/modules/iam/auth/auth.controller.js`,
  `src/modules/iam/auth/auth.service.js`, `src/routes/auth.routes.js`,
  `src/validators/auth.validator.js`, `src/models/User.js`,
  `src/models/LoginAttempt.js`, plus new
  `src/models/EmailVerificationToken.js`,
  `src/repositories/emailVerificationToken.repository.js`, and
  `src/services/emailVerification.service.js`.
- Provisioning, invitations, and sync state: `src/services/tenantInitialization.service.js`,
  `src/repositories/tenant.repository.js`, `src/repositories/setting.repository.js`,
  `src/services/featureFlag.service.js`, `src/services/tenantInvitation.service.js`,
  `src/repositories/tenantInvitation.repository.js`,
  `src/controllers/invitation.controller.js`, `src/routes/invitation.routes.js`,
  `src/validators/invitation.validator.js`, `src/models/TenantInvitation.js`,
  `src/models/Connector.js`, `src/repositories/connector.repository.js`, and
  `src/services/connector.service.js`.
- Backend tests/docs: `tests/self-service-registration.integration.test.js`,
  `tests/tenant-invitation.integration.test.js`,
  `tests/connectors/connector.service.integration.test.js`,
  `tests/helpers/http.js`, and `src/docs/backend/frontend-api-contract.md`.

Frontend changes: `src/features/auth/api/index.ts`,
`src/features/datasets/api/index.ts`, `src/lib/api/types.ts`,
`src/routeTree.gen.ts`, `src/routes/index.tsx`, `src/routes/login.index.tsx`,
`src/routes/register.tsx`, `src/routes/request-access.tsx`,
`src/routes/dashboard.tsx`, and new `src/routes/onboarding.tsx`.
Route regressions are in `src/routes-tests/root-and-login.test.tsx`,
`src/routes-tests/registration.test.tsx`,
`src/routes-tests/dashboard.test.tsx`, and
`src/routes-tests/onboarding.test.tsx`. The frontend API contract doc is also
updated. These are existing uncommitted working-tree changes; no unrelated
changes were reverted.

## Verification Results

Commands were run on the current working tree on 2026-10-12:

| Repository | Command | Result |
| --- | --- | --- |
| Backend | `npm run ci:guards` | Passed: stubs, routes, models, config, README sync (5/5). |
| Backend | `npm test` (first full run) | Passed: 431 tests, 0 failed, 0 skipped. |
| Backend | `npm test` (second sequential full run) | Passed: 431 tests, 0 failed, 0 skipped. |
| Backend | Full suite includes registration/verification, invitation lifecycle, connector validation/preview/sync, dashboard, tenant isolation, and fresh-user onboarding integration coverage. | Passed in both full runs. |
| Frontend | `npm test` | Passed: 25 test files, 240 tests. |
| Frontend | `npm run typecheck` | Passed: `tsc --noEmit`. |
| Frontend | `npm run lint` | Passed with no lint errors; existing shared-component warnings remain. |
| Frontend | `npm run build` | Passed; Vercel output generated. Bundler reports dependency-level `use client` directive warnings. |

Backend integration tests use `mongodb-memory-server`, the test email capture
transport, and the registered in-process connector queue consumer. This
verifies actual test-worker ingestion, not a production Redis/worker deployment.

## Remaining Requirements and Limitations

- Production requires configured email delivery and a running connector worker
  with the configured queue/storage/database infrastructure. These external
  services were not exercised or deployed here.
- No manual browser run or production email-link click was performed; the
  browser-facing flows are covered by frontend route tests and the backend link
  is consumed by the existing verification endpoint in integration tests.
- Guided setup imports CSV/XLSX files. MongoDB connector support exists in the
  platform, but this guided file test/preview/sync workflow does not configure
  arbitrary customer MongoDB connections. Google Sheets remains unsupported.
- No commit, push, deployment, or production-data modification was performed.

## Release Decision

The stated completion criteria are met for the isolated application/test
environment: fresh-user onboarding, worker-confirmed sync, durable resume after
logout/login, security regressions, and required test/build gates all pass.
Production delivery readiness still depends on configuring and validating the
external email and worker infrastructure described above.