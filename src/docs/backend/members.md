# Backend — Workspace members, roles, ownership and deletion

> **WHAT this is:** the reference for tenant self-service membership
> (roadmap 2.10; audit findings ten.05, ten.07, ten.12, ten.14, db.07).
> **WHERE it lives:** `src/docs/backend/members.md`.

## Endpoints (tenant portal, `authenticate` + `resolveTenant`)

| Method | Path (`/api/v1/workspace`) | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/members` | `users.view` | Members with roles and status. Emails only for callers with `users.create` or `users.update` (names-only for Analyst/Viewer). |
| GET | `/members/:userId` | `users.view` | 404 for other tenants' users. |
| PUT | `/members/:userId/roles` | `roles.assign` | `{ roleIds }` replaces the member's unscoped grants. |
| POST | `/members/:userId/deactivate` | `users.update` | Status `suspended`, every session revoked; the seat stays taken. |
| POST | `/members/:userId/reactivate` | `users.update` | Back to `active`. |
| DELETE | `/members/:userId` | `users.delete` | Soft-deletes the account, drops grants and sessions, releases the seat. |
| GET | `/invitations` | `users.create` | History in every status (`?status=`). |
| POST | `/invitations` | `users.create` | Same as `POST /invitations`. |
| POST | `/invitations/:id/resend` | `users.create` | Pending: new link on the same invitation (old link dies, seat kept). Expired: a new invitation. |
| POST | `/invitations/:id/revoke` | `users.update` | Drops the provisional grant, releases the seat; the row is kept. |
| GET | `/roles` | `roles.view` | Roles, permission keys, member counts, `editable`. |
| GET | `/roles/permissions` | `roles.view` | Tenant permission catalogue flagged `held` / `assignable`. |
| POST / PATCH / DELETE | `/roles[/:roleId]` | `roles.create` / `roles.update` / `roles.delete` | Custom roles only; built-in roles are read-only. |
| POST | `/ownership/transfer` | `workspace.transfer` | `{ userId, password }`; Owner only. |
| GET | `/deletion` | `workspace.delete` | Slug to type, grace period, open deletion. |
| POST | `/deletion` | `workspace.delete` | `{ confirm: <slug>, password, reason? }`; Owner only; 202. |

Platform admin (`adminAuth`): `GET /admin/tenant-deletions` (`iam.tenants.view`),
`GET /tenants/:id/deletion` (`iam.tenants.view`), `POST /tenants/:id/deletion/cancel`
`{ reason }` (`iam.tenants.restore`). `POST /tenants/:id/owner` now uses the same
ownership swap (break-glass, optional `reason` recorded).

## Rules

- **No self-modification.** Nobody changes their own roles or status or removes
  themselves (403). Ownership transfer is the way an Owner steps down.
- **Ceiling.** A member can be managed only when their effective permissions are
  a subset of the actor's; only an Owner manages an Owner. A role is granted only
  when it is strictly below the actor's access (an Owner may grant any role).
  Custom roles hold only permissions the actor holds; `workspace.*` stays with the
  Owner role. Refusals are `403 ROLE_CEILING`.
- **Last owner.** A change that would leave no active Owner is `409 LAST_OWNER`
  (deprovisioning through `userService.deactivateMember` included).
  `Tenant.ownerId` follows the remaining active Owners.
- **Serialised.** Membership changes of one tenant run under a lease lock
  (`tenant-members:<tenantId>`); a busy lock answers `409 MEMBERSHIP_BUSY`.
- **Immediate.** Roles are resolved per request; every change bumps the tenant's
  RBAC scope. Deactivation and removal revoke sessions and drop the per-request
  account-status cache, so an existing access token fails on its next request.
- **Step-up.** Transfer and deletion need the actor's password (`403
  STEP_UP_FAILED`, security event), rate limited per user.

## Ownership transfer

Under the membership lock: grant Owner to the target (an active member),
compare-and-set `Tenant.ownerId` (a concurrent transfer loses here and its grant
is rolled back), then remove Owner from the previous owner and grant Admin.
Audited (`tenant.owner_changed`) with security events `OWNERSHIP_TRANSFERRED`,
`ROLE_GRANTED`, `ROLE_REVOKED`.

## Invitations

Link lifetime `INVITATION_TTL_DAYS` (default 7, 1-90). No TTL index: the
`invitation-expiry` job (`JOB_INVITATION_EXPIRY_*`, on by default) moves pending
rows past `expiresAt` to `expired`, drops the provisional grant and releases the
seat. Accepted, revoked and expired rows are history
(`RETENTION_TENANT_INVITATION_DAYS`).

## Workspace deletion

1. The Owner requests deletion: workspace `active` -> `disabled`, every session
   revoked, a `TenantDeletion` record with `purgeAfter = now +
   TENANT_DELETION_GRACE_DAYS` (default 30), Owners emailed.
2. During the grace period a platform admin can cancel (the workspace reopens).
   `POST /tenants/:id/restore` is refused with `409 DELETION_PENDING`.
3. The `tenant-purge` job (`JOB_TENANT_PURGE_*`, **off by default**) claims due
   records with a lease and deletes every record listed in
   `src/services/tenantPurge.registry.js` (raw collections, soft-deleted rows
   included), the tenant's files under `reports/<id>/` and `audit/exports/<id>/`,
   and finally the Tenant document. It then counts again and stores the
   verification report on the record (`verification.ok`, per-collection
   `deleted` / `remaining`, retained collections with their policy, storage).
   A failed or unverified purge is retried with backoff up to
   `TENANT_PURGE_MAX_ATTEMPTS`. A workspace that is `active` or `pending` is
   never purged (`TENANT_ACTIVE`).
4. Retained under policy: AuditLog and AccessLog (`TENANT_PURGE_RETAIN_AUDIT_LOGS`),
   ComplianceLog (compliance evidence), PaymentTransaction, SubscriptionHistory
   and billing WebhookEvents (`TENANT_PURGE_RETAIN_BILLING_RECORDS`).
5. Opt-in: `TENANT_PURGE_ARCHIVED_ENABLED` schedules archived workspaces
   `TENANT_ARCHIVED_RETENTION_DAYS` after archiving.

`tests/members/tenant-deletion.integration.test.js` fails when a model with a
`tenantId` path is not listed in the registry.

## Soft delete and unique indexes

Unique indexes on User (tenant+email, SSO), Role (tenant+name), UserRole,
Setting, FeatureFlag, Module and Permission are partial on `deletedAt: null`, so
a removed member's email, a deleted role's name or a deleted key can be used
again. Existing databases: `npm run db:member-indexes` (dry run) then
`-- --apply` rebuilds those indexes and drops the old invitation TTL index.

## Operator steps

`npm run db:member-indexes` (review, then `--apply`), `npm run db:indexes`,
`npm run db:permissions` (adds `workspace.transfer` / `workspace.delete` to Owner
and `users.delete` / `roles.assign` to Admin in existing workspaces); review the
retention of billing records with legal before enabling `JOB_TENANT_PURGE_ENABLED`
on the worker.
