# 05. Roles, personas and permission matrix

**Audience:** product and engineering leads defining who can do what in Analivo, and the engineers who will migrate the current role data to the target model.

**Summary.** Analivo already has the right primitives: two separate identity planes (tenant users and platform admins), roles stored as data, `module.action` permission keys, and default-deny enforcement in `permission.middleware.js`. What it lacks is a coherent role model on top of them. Tenants get four seeded roles but no way to manage membership or roles themselves; platform admins all receive the same all-powerful bootstrap role regardless of type; several permission keys the code checks are never created; and a handful of defects let users exceed their intended role. The target model below keeps the primitives and replaces the role catalogue in a backward-compatible migration.

## 1. The current role system (as built)

| Element | Implementation | Evidence |
|---|---|---|
| Tenant identities | `User` documents, unique per `{tenantId, email}`; status `invited`/`unverified`/`active`/`suspended`/`locked` | `backend/src/models/User.js` |
| Platform identities | `Admin` documents, globally unique email; `adminType` `super`/`platform`/`support`; optional `tenantScope` for tenant-bound support staff | `backend/src/models/Admin.js:30-37` |
| Roles | `Role` (tenant-scoped or platform with `tenantId: null`), `RolePermission`, `UserRole`, `AdminRole` (optionally per tenant, optionally expiring) | `backend/src/models/{Role,RolePermission,UserRole,AdminRole}.js` |
| Permission keys | `module.action`; tenant modules use bare names (`users.*`, `dashboards.*`), platform modules use `iam.*` and governance modules | `backend/src/services/tenantInitialization.service.js:45-74`, `backend/src/models/Module.js` |
| Enforcement | `permission(module, action)` resolves the actor's permissions (60 s versioned cache) and denies by default | `backend/src/middleware/permission.middleware.js`, `backend/src/services/rbac.cache.service.js` |
| Tenant defaults | Owner (system), Admin, Manager, Viewer seeded on onboarding | `tenantInitialization.service.js:81-152` |
| Platform defaults | One bootstrap role named after the `adminType`, granted every built-in and `iam.*` module × canonical action; `adminType` itself is not enforced by middleware | `backend/src/services/adminBootstrap.service.js:15-20,86-91`; {{TEN:platform-roles}} |
| Frontend gating | The tenant profile (`GET /users/me`, also `/auth/me`) returns no roles or permissions. Feature pages gate with `lib/permissions.hasPermission`, which denies an empty list, so **every tenant user, including the owner, is shown "Permission required"** on the main feature pages. The backend remains authoritative and would have allowed the calls | `backend/src/services/user.service.js:42-46`, `frontend/src/lib/permissions/index.ts:46-48`, `frontend/src/features/datasets/components/ConnectorList.tsx:70,97`; {{FE:perm-gate}}, {{TEN:me-perms}} |

### 1.1 Seeded tenant permissions today

`✓` = granted by the seed. Settings, feature-flag and email-template permissions are granted but their HTTP surfaces return 501.

| Module (actions) | Owner | Admin | Manager | Viewer |
|---|---|---|---|---|
| users (view, create, update, delete) | all | view, create, update | view | view |
| roles (view, create, update, delete, assign) | all | view | — | — |
| settings (view, configure, update, delete) | all | all | — | — |
| feature_flags (view, configure, update, delete) | all | all | — | — |
| analytics (view, create, update, delete, export) | all | all but delete | view, create, update | view |
| connectors (view, create, update, delete, configure, preview, sync) | all | all but delete | view | view |
| dashboards (view, create, update, delete) | all | all but delete | view, create, update | view |
| reports (view, create, update, delete, export) | all | all but delete | view, create, update | view |
| alerts (view, create, update, delete, evaluate) | all | all but delete | all but delete | view |
| notifications (view, configure, update, delete) | all | all | view | view |
| email_templates (view, create, update, delete) | all | all but delete | — | — |
| api_keys (view, create, update, delete) | all | all but delete | view | — |
| embed (view, create, delete) | all | view, create | view | — |
| master_data (view) | ✓ | ✓ | ✓ | ✓ |
| billing / subscriptions | **not seeded** (code checks `iam.subscriptions.*` keys that are never created) | — | — | — |

### 1.2 Defects in the current model

| Defect | Effect | Finding |
|---|---|---|
| Invitations take a free-text `roleName` | A tenant Admin (or anyone with `users.create`) can invite a new member as Owner | {{TEN:invite-owner}} |
| Invitation provisioning pre-creates the user and grants the role | A revoked or expired invitee can still activate through password reset and log in | {{TEN:invite-revoke}} |
| No tenant-side membership or role management | Owners cannot change a member's role, suspend or remove a member | {{TEN:no-member-mgmt}} |
| `GET /users` and `GET /users/:id` have no permission gate | Any authenticated member can enumerate members' contact details | {{TEN:users-ungated}} |
| Ownership transfer rewrites only `Tenant.ownerId` | No Owner role is granted to the new owner or removed from the old one; `ownerId` is never used for authorisation | {{TEN:ownership}} |
| Billing permission keys never registered | Workspace billing self-service and admin plan routes return 403 on a fresh deployment | {{TEN:billing-keys}} |
| `/api-keys` and `/embed/tokens` never resolve a tenant | Repositories drop the tenant filter, enabling cross-tenant read/update/revoke by id (latent while creation is also broken) | {{TEN:apikey-idor}} |
| Platform role assignment has no ceiling or self-target check | An admin with `iam.admins.assign` can grant themselves the super role | {{ADM:self-escalate}} |
| Admins can change their own `adminType` and `tenantScope` | Self-promotion and self-unscoping | {{ADM:self-patch}} |
| Support `tenantScope` is not applied to `/tenants/:id/*`, and `/admin-auth/me` resolves permissions at a different scope from enforcement | Scoped support staff are not actually confined; the UI shows a different permission set than the API enforces | {{TEN:support-scope}}, {{ADM:me-scope}} |
| Tenant-scoped admin grants cannot be revoked through the API | Stale grants accumulate | {{ADM:revoke-scoped}} |
| `pending` admins can log in | Accounts awaiting activation are usable | {{AUTH:pending-admin}} |
| Admin list returns password hashes and MFA secrets | Any holder of `iam.admins.view` obtains every admin's hash | {{ADM:pwhash}} |

## 2. Persona mapping

| Target persona (brief §4) | Closest current role | Gap |
|---|---|---|
| Public visitor | Anonymous routes (`/`, `/register`, `/request-access`, policy pages) | No public docs, pricing or status pages (document 15) |
| Tenant owner | Owner (system role) | Ownership is not a first-class concept; no transfer workflow; no owner-only guard on destructive tenant actions |
| Tenant administrator | Admin | Can mint Owners through invitations; cannot manage roles or members (no API exists) |
| Analyst | Manager | Name differs; cannot create connectors (matches the brief's intent if that is the decision) |
| Viewer | Viewer | Can enumerate members through the API; in the UI, like every tenant role, is blocked by the empty-permission gate |
| Developer / integration operator | none | API keys and embed permissions are folded into Owner/Admin |
| Platform super administrator | bootstrap `super` role | Same grants as `platform` and `support` roles |
| Platform administrator | bootstrap `platform` role | Identical to super; no permission groups |
| Support operator | bootstrap `support` role + optional `tenantScope` | Identical to super; scope not enforced; impersonation is a full user session |
| Read-only auditor | none | Must be built |

## 3. Target permission matrix

Legend: **C** create, **V** view, **U** update, **D** delete/archive, **E** export, **S** share/publish, **A** administer/assign, **Ap** approve. "own" means only resources the user created; "scoped" means only within an explicitly granted tenant and time window; "meta" means metadata and diagnostics, never row-level customer data; "—" means no access.

| Action | Visitor | Owner | Tenant admin | Analyst | Viewer | Developer | Super admin | Platform admin | Support | Auditor |
|---|---|---|---|---|---|---|---|---|---|---|
| Register / request access | C | — | — | — | — | — | — | — | — | — |
| Workspace profile and settings | — | V U | V U | V | V | V | V (meta) | V (meta) | V (meta, scoped) | V (meta) |
| Close / delete workspace, request export | — | D E Ap | — | — | — | — | Ap (policy-bound) | — | — | — |
| Transfer ownership | — | A | — | — | — | — | A (break-glass, audited) | — | — | — |
| Invite members | — | C | C (roles ≤ own) | — | — | — | — | — | — | — |
| Change member roles | — | A | A (roles below Admin) | — | — | — | — | — | — | — |
| Suspend / remove members | — | D | D (non-owners) | — | — | — | — | — | — | — |
| View member list | — | V | V | V (names only) | V (names only) | V (names only) | V (meta) | V (meta) | V (meta, scoped) | V (meta) |
| Connect data sources / upload | — | C U D | C U D | — | — | — | — | — | — | — |
| Trigger dataset refresh | — | ✓ | ✓ | ✓ | — | ✓ | — | — | ✓ (scoped, audited) | — |
| View dataset schema and rows | — | V | V | V | V (via dashboards) | V | — | — | — | — |
| Run ad-hoc queries | — | ✓ | ✓ | ✓ | — | ✓ | — | — | — | — |
| Ask AI questions (when shipped) | — | ✓ | ✓ | ✓ | ✓ (published metrics only) | — | — | — | — | — |
| Create / edit dashboards | — | C U D | C U D | C U D (own) | — | — | — | — | — | — |
| View dashboards | — | V | V | V | V | V | — | — | — | — |
| Publish / share dashboards internally | — | S | S | S (own) | — | — | — | — | — | — |
| Export data | — | E | E | E | E (only if enabled per dashboard) | E | — | — | — | — |
| Reports and schedules | — | C U D | C U D | C U D (own) | V | — | — | — | — | — |
| Alerts and anomaly rules | — | C U D | C U D | C U D (own) | V, acknowledge | — | — | — | — | — |
| Metric definitions (approve) | — | Ap | Ap | C (draft) | — | — | — | — | — | — |
| API keys | — | C U D | C U D | — | — | C U D | — | — | — | V (meta) |
| Embed configurations and tokens | — | C S D | C S D | — | — | C S D | — | — | — | V (meta) |
| Billing and plan | — | V U | V | — | — | — | V U (overrides audited) | V | — | V |
| Tenant audit log | — | V E | V | — | — | V (integration events) | V E | V | V (scoped) | V E |
| Platform tenants list and lifecycle | — | — | — | — | — | — | V A | V A (suspend/restore) | V (scoped) | V |
| Platform administrators | — | — | — | — | — | — | C U D A | V | — | V |
| Platform configuration and flags | — | — | — | — | — | — | U (two-person for security policy) | U (non-security) | — | V |
| Plans and entitlements catalogue | — | — | — | — | — | — | C U D | U | — | V |
| Support diagnostics (sanitised) | — | — | — | — | — | — | V | V | V (scoped) | V |
| Impersonation / row-level data access | — | Ap (tenant consent) | — | — | — | — | — | — | time-bound, justified, consented, read-only by default | — |
| Platform audit and security events | — | — | — | — | — | — | V E | V | — | V E |
| Incidents | — | V (status page) | V | — | — | — | C U | C U | C U | V |

## 4. Guardrails the model must enforce server-side

1. **Role ceiling.** A user can grant only roles strictly below their own (Owner > Admin > Analyst, Developer > Viewer). The same rule applies to platform admins (Super > Platform > Support > Auditor) and to invitations.
2. **No self-modification of privilege.** No actor can change their own roles, `adminType`, `tenantScope`, or status.
3. **Last-owner and last-super protection.** A tenant always has at least one active Owner; the platform always has at least one active Super admin (the latter exists today for suspend/demote and must extend to role revocation and deletion).
4. **Ownership transfer** requires the current owner (or a break-glass Super admin with a recorded reason), targets an active member, grants the Owner role to the new owner and downgrades the previous owner in one audited operation.
5. **Plane separation.** Tenant tokens never reach `/admin*`; admin tokens never reach tenant data routes except through the support workflow. This already holds through JWT audiences and must be covered by tests.
6. **Support access** is a request-and-approve workflow: justification, tenant (or Super admin) approval, time limit, read-only by default, a banner in the tenant UI, every action attributed to the operator, and automatic expiry (document 10 §7).
7. **Auditor** has no write permission anywhere, sees redacted personal data by default, and exports are themselves audited.
8. **Permission changes take effect immediately.** Role changes bump the RBAC cache version (already done for most writes, not for invitation grants) and revoke or refresh affected sessions.

## 5. Migration from the current model

| Step | Change | Compatibility |
|---|---|---|
| M1 | Register the missing permission keys (`iam.subscriptions.*`, `iam.entitlements.*`, `billing.*`) and grant them to Owner and to the right platform roles | Idempotent seed; fixes 403s on existing tenants |
| M2 | Rename Manager to Analyst in the UI only (keep the stored role name, add a display label) | No data change |
| M3 | Add a Developer tenant role (api_keys, embed, analytics.view, connectors.view, dashboards.view) | New role row per tenant via an idempotent migration; existing Owner/Admin grants unchanged |
| M4 | Mark all four default tenant roles `isSystem: true` and version the role templates | Prevents platform admins from deleting roles invitations depend on |
| M5 | Replace the single bootstrap role with Super, Platform, Support and Auditor platform roles with distinct grants; map existing admins by `adminType` | Requires a reviewed migration and a dry-run report listing every admin's before/after permissions |
| M6 | Replace free-text `roleName` on invitations and access-request approval with a role id validated against the ceiling | API change; frontend sends ids |
| M7 | Expose tenant role and member management endpoints (`PATCH /users/:id/role`, `POST /users/:id/suspend`, `DELETE /users/:id`) | New endpoints |
| M8 | Return roles and effective permissions from the tenant profile endpoints (`/users/me` and `/auth/me`), and make the two frontend helpers agree (deny on empty, after the backend returns permissions) | Coordinated frontend/backend release; this is also the fix for the tenant UI being blocked today, so it belongs in roadmap phase 0 |

Each step's tests are listed in `17-testing-audit-and-regression-matrix.md` (scenarios 2, 3, 15, 16) and the sequencing is in `20-implementation-roadmap.md`.
