# Workspace Settings, Feature Entitlements, and MFA Audit

Date: 2026-10-24

## Scope and safety

This audit covers the workspace Settings surface, support access, roles and permissions, feature availability, subscription entitlements, and tenant-user MFA. No production configuration, subscription, customer data, or production setting was changed. No commit, push, or deployment was performed.

## Confirmed root causes

### Workspace features

The Settings card previously consumed the platform feature-flag evaluation as a bare `Record<string, boolean>`. That response did not explain rollout, platform disablement, plan entitlement, or operational configuration. The UI therefore could not distinguish an allow-list miss from a plan restriction or an unconfigured provider.

The platform already has two authoritative systems:

1. `featureFlag.service.js` evaluates platform rollout flags per tenant.
2. `entitlement.service.js` resolves the effective subscription plan, lifecycle state, and entitlement overrides. Backend `requireFeature` middleware enforces the billing feature keys.

The corrected evaluation response combines those sources without creating a second entitlement system. It returns the effective value, reason, plan inclusion when a feature has a canonical billing key, whether workspace configuration is required, whether the implementation is present, and whether it is operational. Internal `ai.kill_switch` state is not exposed to tenant users.

The exact live status of a particular customer workspace requires its authenticated API response and current database state; this repository audit does not invent that state.

Known catalogue facts:

- AI assistant is plan-entitled only on the reference Pro and Enterprise plans, is controlled by `ai.assistant`, requires workspace consent, and requires a configured non-`noop` provider. The default provider is `noop`, so AI is unavailable until platform configuration and plan/rollout conditions are satisfied.
- Webhook connectors have a canonical `webhook_connectors` plan entitlement and are implemented, but still require a workspace rollout and connector configuration/signing setup.
- CSV export and realtime analytics currently have platform feature flags but no matching billing feature key in the canonical plan contract. They are not presented as plan-restricted unless the backend has such an entitlement.
- EU compliance mode is a platform flag. The repository does not establish that enabling this flag alone constitutes a complete regulatory compliance program; the UI reports only the effective flag state and does not make legal claims.

### MFA

MFA was already implemented server-side. The earlier problem was discoverability and explanation, not a missing client-side toggle. Tenant MFA uses encrypted TOTP secrets, server-side verification, hashed recovery-code storage, replay protection, and login challenges. Secrets and recovery codes are not part of normal profile responses.

Workspace MFA is stored as the tenant setting `security.mfa_required`. The backend refuses to enable the policy unless the actor has already enrolled MFA, preventing the owner from locking themselves out. When the policy is active, members without enrollment receive an enrollment-restricted authentication session and cannot use normal tenant routes until enrollment completes. The setting is therefore Off by default unless persisted otherwise; the frontend now explains this behavior and links to Profile & Security for individual enrollment.

### Member permissions

The backend permission catalogue is authoritative and uses stable `<module>.<action>` identifiers. Built-in roles are not editable; custom roles are constrained by the actor's effective permissions. The frontend showed raw permission keys on role cards even though the backend catalogue already returned module, action, description, and assignability metadata. Role cards now use that catalogue data, retain the identifiers for exactness, and explain the effective access in readable terms.

### Support Access

Support access was already tenant-scoped and paginated in the backend activity endpoint, but the workspace UI did not expose page navigation. Grant history was also fetched as a bounded first page without metadata. The workspace endpoint now accepts validated `page` and `limit` parameters for grants and returns grant pagination metadata. Activity and grant history both render bounded pages with Previous/Next controls.

## Support Access authorization model

- A workspace Owner/Admin holding `settings.configure` grants or revokes consent.
- Platform support identities use a granted session only when the grant is active, unexpired, and applicable to that operator.
- Break-glass access is requested by support staff and requires approval by a different active, unscoped super-admin.
- Sessions are read-only. Unsafe methods are rejected by the impersonation middleware.
- Consent duration is bounded by backend configuration and validated server-side. Sessions stop at expiry and are invalidated when their grant is revoked or the workspace is suspended.
- Grant, decision, revocation, refused attempt, session start/end, and support actions are audited. Workspace views omit IP addresses, user agents, secrets, and audit before/after payloads.
- Every workspace read filters explicitly by the resolved tenant ID. Cross-tenant IDs and forged tenant headers are rejected by authentication, tenant resolution, and authorization middleware.

## Files changed

### Frontend

- `src/features/support/api.ts`
- `src/features/support/types.ts`
- `src/features/support/components/SupportAccessCard.tsx`
- `src/features/feature-flags/api/index.ts`
- `src/features/feature-flags/hooks/useFeatureFlags.ts`
- `src/features/feature-flags/components/WorkspaceFeaturesCard.tsx`
- `src/features/feature-flags/components/WorkspaceFeaturesCard.test.tsx`
- `src/features/members/components/RolesView.tsx`
- `src/features/auth/mfa/WorkspaceSecurityCard.tsx`

### Backend

- `src/validators/supportAccess.validator.js`
- `src/routes/workspace-support.routes.js`
- `src/controllers/supportAccess.controller.js`
- `src/services/supportAccess.service.js`
- `src/repositories/supportAccess.repository.js`
- `src/controllers/featureFlag.controller.js`
- `src/services/featureFlag.service.js`

## API behavior

`GET /api/v1/workspace/support-access?page=1&limit=10` now returns the bounded grant page plus `grantsMeta`. The endpoint remains protected by `authenticate`, `resolveTenant`, `settings.view`, and validated query parameters.

`GET /api/v1/workspace/support-access/activity?page=1&limit=10` remains backend-paginated and tenant-scoped. Ordering is newest first with `_id` as a unique tie-breaker.

`GET /api/v1/feature-flags/evaluate` preserves the legacy `flags` object for compatibility and additionally returns detailed `features` entries with effective availability, reason, plan inclusion where applicable, configuration status, implementation status, and operational status.

## MFA capabilities and remaining gaps

Implemented:

- Tenant-user authenticator enrollment and server-side TOTP verification.
- Encrypted secret storage and hashed recovery-code storage.
- Login MFA challenges and recovery-code handling.
- Workspace MFA policy persistence and server-side enforcement.
- Owner-only policy configuration and owner self-enrollment protection.
- Session revocation after enrollment/reset where required.
- Security audit events for enrollment, disablement, reset, and policy changes.

Remaining operational dependencies:

- Users must individually enroll through Profile & Security.
- A workspace policy cannot be enabled by an owner who has not enrolled MFA.
- The local integration environment could not complete Mongo-backed tests because its `mongodb-memory-server` binary failed MD5 verification; this is an environment dependency failure before test hooks, not a reported application assertion.

## Validation evidence

Passed:

- Frontend targeted Settings/support/feature/MFA tests: 22 tests passed.
- Frontend typecheck passed.
- Frontend lint passed with 9 pre-existing Fast Refresh warnings and 0 errors.
- Frontend production build passed.
- Backend changed-file `node --check` syntax validation passed.
- Backend `npm run ci:guards` passed: stubs, routes, models, config, and README sync checks.

Blocked:

- Backend support-access and feature-flag integration suites could not start because `mongodb-memory-server` reported an MD5 mismatch between the downloaded binary and its check file. No production database was contacted or mutated.

Browser viewport verification was not available in the execution environment. No production settings, subscriptions, or feature flags were changed during this work.
