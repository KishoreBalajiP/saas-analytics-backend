# Backend Repair Roadmap

## Phase 0 — Audit and documentation reconciliation

Findings: ANA-BE-001, ANA-BE-007.  
Entry: baseline reports exist and implementation work is frozen.  
Work: reconcile stale status documents, establish the authoritative status source, inventory every registered route with middleware, validator, response, tenant scope, and test references.  
Exit: documentation is internally consistent; every route is classified as implemented, stubbed/fail-closed, planned, or future; contract gaps are explicit.  
Risk/rollback: documentation-only; restore prior text if reviewers reject authority decisions.

## Phase 1 — Critical tenant and security verification

Findings: ANA-BE-004, ANA-BE-005, ANA-BE-006.  
Entry: route/resource matrix and focused baselines are complete.  
Work: add failing two-tenant tests for resource reads, writes, deletes, exports, cache keys, webhook/API-key/embed paths, and background jobs; verify connector URL/network protections and idempotent retry behavior; fix only reproduced defects.  
Exit: approved P1 defects are fixed or explicitly contained, negative tests pass, and no critical unresolved issue is hidden.  
Migration: none unless a demonstrated data constraint requires one; any migration gets a separate compatibility/rollback review.  
Rollback: revert the focused code change and retain regression tests if a fix harms valid access.

## Phase 2 — Dependency and quality gates

Findings: ANA-BE-002, ANA-BE-003.  
Entry: XLSX behavior and current dependency tree are baselined.  
Work: evaluate non-breaking dependency options first; if none exist, document accepted risk or approve a breaking upgrade with XLSX regression coverage. Evaluate type-check/lint adoption only if configuration cost is bounded.  
Exit: audit risk is remediated or accepted with owner/expiry; any new gate passes in CI and locally.  
Rollback: lockfile/package change is revertible; no force upgrade without review.

## Phase 3 — API/data-integrity hardening

Scope: validated gaps discovered in Phase 0/1; pagination bounds, response consistency, compound tenant uniqueness, atomic updates, exports, and concurrency.  
Exit: focused API, integrity, and concurrency tests pass; public contracts are preserved or documented with migration strategy.

## Phase 4 — Operational/staging verification

Finding: ANA-BE-008.  
Scope: authorized staging only—MongoDB, Redis/BullMQ, object storage, mail, billing webhook, provider failure, health/readiness, shutdown, proxy/CORS, and secret configuration.  
Exit: exact environment prerequisites and observed results are documented; no production claim is made from staging-only evidence.

## Final verification

Run the actual available test suite, all CI guards, dependency audit, route/contract checks, and approved staging checks. Update every finding to Verified fixed, Implemented/partially verified, Blocked, Accepted risk, or Needs review. Do not declare production readiness solely from test success.

