# Analivo Phase 4 — Self-Service Onboarding Plan

Date: 2026-10-12

## Execution Status

Implementation and isolated release checks are complete. See
[`PHASE_4_ONBOARDING_REPORT.md`](./PHASE_4_ONBOARDING_REPORT.md) for verified
behavior, exact gate results, and production-environment limitations.

## Scope

This plan covers the customer registration and onboarding request. It is separate
from the existing enterprise-scale Phase 4 roadmap in
`backend/src/docs/phases/phase-4.md`, which concerns KMS, multi-region hosting,
data residency, custom domains, and white-labeling.

The product objective is a real journey from public registration through email
verification, tenant owner sign-in, first supported data import, dashboard, and
optional teammate invitation. Existing authentication, tenant provisioning,
connector, dashboard, and invitation services remain authoritative.

## Audit Baseline

- Phase 1 and Phase 2 records describe the shared backend foundation and MVP;
  Phase 2's original signup flow assumed platform-admin tenant provisioning.
- Phase 3 security operations hardened production behavior; Google Sheets is
  explicitly unwired and must not be marketed as supported.
- Registration and email verification were already present in the working tree,
  but the email link did not invoke verification in the browser.
- The initial onboarding page created empty CSV/XLSX/MongoDB/webhook connector
  records with placeholder configuration. It did not validate, preview, sync,
  or confirm worker completion.
- Fresh tenant roles lacked the `connectors.preview` and `connectors.sync`
  permissions required by the existing connector endpoints.
- Tenant-owner invitation APIs did not exist; invitation routes were only
  available to platform admins.
- Provisioning activated tenants outside an atomic pending-state transition;
  verification could reactivate restricted tenants and concurrent setup could
  collide on unique seed records.

## Implementation Workstreams

1. **Registration and verification**
   - Preserve public signup and the existing tenant auth system.
   - Consume verification links from `/register?token=...`.
   - Require a live, single-use token bound to the registered user and tenant.
   - Provision roles/settings before tenant activation; never overwrite a
     restricted lifecycle state.
   - Treat duplicate workspace slug races as conflicts and avoid orphaning an
     untouched tenant if owner creation fails.

2. **Tenant-authorized onboarding operations**
   - Add the missing preview/sync permissions to the built-in connector
     permission catalogue and Owner/Admin roles.
   - Reuse existing connector validation, file preview, queue synchronization,
     row listing, dashboard, and invitation services.
   - Add an authenticated owner/admin invitation endpoint bound to JWT tenant
     context, defaulting to Viewer and reusing an existing pending invitation
     on retries.

3. **Customer UX and resume**
   - Route public signup CTAs to `/register`; keep login, password recovery,
     invitation acceptance, and platform-admin login available.
   - Support guided CSV/XLSX upload only: validate config, test/preview the
     actual file, enqueue sync, and show completion only after the worker's
     `lastSyncedAt` and persisted row count confirm it.
   - Reconstruct completed checkpoints from tenant-scoped connector and
     dashboard records on every entry. Do not store authoritative progress or
     connector secrets in browser storage.
   - Provide retries and an optional Viewer invitation; leaving setup does not
     discard server-side records.

4. **Security and compatibility**
   - Cover verification expiry, replay, restricted tenants, concurrent signup
     and verification, owner assignment, unauthenticated protected resources,
     tenant-header forgery, invite retry, and existing invitation lifecycle.
   - Preserve existing login/session/password reset and dashboard/connector
     authorization contracts.

## Verification Gates

- Isolated fresh-user HTTP journey: register → verify → login → create source →
  validate → preview → enqueue and process sync → confirm rows → create/read a
  dashboard → invite a Viewer → logout/login → reconstruct server state.
- Run registration/email verification and tenant invitation integrations.
- Run connector preview/sync and dashboard/tenant-isolation tests.
- Run backend CI guards and the complete backend test suite twice sequentially.
- Run all frontend tests, TypeScript, lint, and production build.
- Inspect both repository diffs/status and document infrastructure prerequisites
  and any unverified browser or external-service behavior.

## Completion Standard

Phase 4 is complete only when a fresh isolated owner completes the actual HTTP
journey, completion survives refresh and logout/login from authoritative state,
tenant boundaries remain intact, and every required regression/release gate
passes. A `202 Accepted` queue response alone is not evidence of a successful
sync; completion requires a worker-updated timestamp and persisted rows.