# 05 — User Journey

> **WHAT this is:** the persona-by-persona reference for every role on
> the platform — what they can do, what they cannot, and what their
> day looks like.
> **WHY it exists:** a feature list is impersonal; personas are.
> Every spec, every test, every sprint plan answers *"which persona
> does this serve?"*.
> **HOW to use it:** read your persona once at onboarding. Re-read it
> whenever a sprint plan asks whether a feature is in scope.
> **WHEN to update it:** when a new persona is added, when a
> permission changes shape, or when a daily workflow step changes.
> **WHERE it lives:** `src/docs/05-user-journey.md`.

---

## Purpose

> **WHAT this is:** the persona-by-persona reference for every role
> on the platform.
> **WHY it exists:** features are impersonal; personas are not. A
> single document that names each persona, lists their permissions
> and walks through a day in their life prevents spec-by-spec
> reinvention of the audience.
> **HOW to use it:** read your persona at onboarding. Re-read it when
> a sprint plan asks *which persona does this serve?*.
> **WHEN to update it:** when a new persona is added, when a
> permission changes shape, or when a daily workflow step changes.
> **WHERE it lives:** `src/docs/05-user-journey.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Product manager** | Knows which persona a spec is for before they write it. |
| **UX designer** | Has the daily workflow to anchor wireframes. |
| **Backend engineer** | Has the permission set to wire into RBAC. |
| **Sales engineer** | Has the personas to role-play in a demo. |
| **Tech support / Support Engineer** | Has the boundary list to know what they can and cannot do. |
| **Interview candidate** | Has the canonical personas to anchor any system-design answer. |

## Current Status

> **Status:** `Planned` — every persona description below reflects the
> *target* state. The role records themselves (`Role`, `Permission`,
> `User`, `Admin`) are still placeholders; the seed for the system
> roles ships in Sprint 3.
> **Sprint:** Sprint 0 (complete); the personas are exercised end
> to end across Sprints 1–3.
> **Owner:** Product + Engineering.

## Business Perspective

The platform serves **two audiences** that share one backend:

1. **Our own team** — the platform operator. They run the Admin Portal.
2. **The customer's team** — every customer is one tenant. They run
   the Tenant Portal.

Inside each audience there are personas. The Admin Portal has
*Platform Owner / Super Admin*, *Platform Admin* and *Support
Engineer*. The Tenant Portal has *Tenant Owner*, *Tenant Admin*,
*Manager*, *Analyst* and *Viewer*. Personas inherit permissions
through the dynamic RBAC engine (Sprint 3); system roles are seeded;
custom roles are built on top.

The vocabulary in this document is **canonical**. Use it in specs,
commit messages, demo scripts and interview answers. If you need a
new persona, add a row here before you add it anywhere else.

## Technical Perspective

Every persona below maps to a `Role` document seeded by
`src/modules/iam/roles/roles.seed.js` (Sprint 3). The role carries
an array of `Permission` references; the permissions are read into
the cache at `iam:rbac:<scope>` (Sprint 3) and consulted by
`middleware/permission.middleware.js`.

| Persona | System role seed | Scope | Audience |
| --- | --- | --- | --- |
| Platform Owner | `super_admin` | platform | Admin Portal |
| Super Admin | `super_admin` | platform | Admin Portal |
| Platform Admin | `platform_admin` | platform | Admin Portal |
| Support Engineer | `support_admin` | platform (with `tenantScope: '*'`) | Admin Portal |
| Tenant Owner | `tenant_owner` | tenant | Tenant Portal |
| Tenant Admin | `tenant_admin` | tenant | Tenant Portal |
| Manager | custom role (built on `tenant_member`) | tenant | Tenant Portal |
| Analyst | custom role (built on `tenant_member`) | tenant | Tenant Portal |
| Viewer | custom role (built on `tenant_member`) | tenant | Tenant Portal |

> The JWT `aud` claim (`user` / `admin`) and the `tenantScope` claim
> (`'tenant_id'` or `'*'`) are how the code distinguishes an Admin
> Portal request from a Tenant Portal request without trusting the
> URL.

## Architecture

```
                          ┌────────────────────────────┐
                          │      Our own team           │
                          │  (Admin Portal / /admin-*) │
                          └─────────────┬──────────────┘
                                        │
                ┌───────────────────────┼────────────────────────┐
                │                       │                        │
         ┌──────▼─────┐          ┌──────▼─────┐           ┌────────▼────────┐
         │ Platform   │          │ Platform   │           │ Support         │
         │ Owner      │          │ Admin      │           │ Engineer        │
         │ super_admin│          │platform_   │           │ support_admin   │
         │            │          │ admin      │           │ tenantScope:'*' │
         └──────┬─────┘          └──────┬─────┘           └────────┬────────┘
                │                       │                        │
                │ sees every tenant;   │ sees every tenant;     │ impersonates
                │ cannot be demoted    │ manages platform       │ any tenant user
                │ without another      │ configuration &        │ with a reason;
                │ super + MFA + 24h    │ connectors             │ daily cap
                └───────────────────────┴────────────────────────┘

                          ┌────────────────────────────┐
                          │     Customer's team         │
                          │ (Tenant Portal / /auth/*)   │
                          └─────────────┬──────────────┘
                                        │
                ┌───────────────────────┼────────────────────────┐
                │                       │                        │
         ┌──────▼─────┐          ┌──────▼─────┐           ┌────────▼────────┐
         │ Tenant     │          │ Tenant     │           │ Manager /       │
         │ Owner      │          │ Admin      │           │ Analyst /       │
         │ tenant_    │          │ tenant_    │           │ Viewer          │
         │ owner      │          │ admin      │           │ (custom roles)  │
         └────────────┘          └──────┬─────┘           └─────────────────┘
                                        │ invites, sets roles
                                        ▼
                              ┌──────────────────┐
                              │  tenant users    │
                              └──────────────────┘
```

Three rules to remember:

1. **Permissions are data, not code.** Sprint 3 ships the seed for
   the six system roles; tenants extend them.
2. **JWT audience = audience.** `aud: 'user'` for Tenant Portal;
   `aud: 'admin'` for Admin Portal. The middleware checks both
   audience and role.
3. **Support Engineers impersonate, never own.** Every
   impersonation requires a mandatory `reason` and is logged twice
   (audit + access).

---

## Personas

### Platform Owner (super_admin)

**Responsibilities**

- Owns the platform. Has every permission across every tenant.
- Approves new platform admins.
- Approves destructive operations (tenant hard-delete after
  retention, KMS key rotation, regional failover).
- Cannot be demoted or suspended except by another super admin with
  MFA + a 24-hour cool-down (per `iam/admins/README.md`).

**Permissions**

- All `iam.*`, `platform.*`, `governance.*`, `analytics.*`,
  `connectors.*`, `tenants.*`, `users.*`, `roles.*`,
  `permissions.*`, `settings.*`, `feature_flags.*`,
  `master_data.*`, `monitoring.*`, `notifications.*`,
  `email_templates.*`, `audit_logs.*`, `access_logs.*`,
  `compliance.*`, `support.*` actions across every module.
- Cannot delete the last remaining `super_admin` (the system keeps
  at least two).

**Daily workflow**

1. Reviews `/audit-logs` for anomalous cross-tenant access.
2. Reviews `/monitoring/aggregate` for system health.
3. Approves or denies `support_admin` impersonation requests.
4. Reviews quarterly compliance reports generated by
   `/compliance/*`.

**Example**

> *Tuesday morning* — a customer reports an outage in eu-west-1. The
> Platform Owner opens `/monitoring/system`, sees the storage
> adapter is failing health checks, opens the runbook in
> `docs/deployments.md` (planned), and pages the on-call SRE.

---

### Super Admin

**Status:** `Planned` — Sprint 3.
**Responsibilities:** Identical to Platform Owner. The two names exist
because the *Platform Owner* is the founder / founding architect who
cannot be removed; a *Super Admin* is anyone else holding the
`super_admin` role.

In practice: every super admin holds every permission. The
distinction is operational (founder vs. delegate) and lives in
audit-log annotations, not in code.

---

### Platform Admin (`platform_admin`)

**Responsibilities**

- Manages platform-wide configuration: settings, feature flags,
  notification templates, master data.
- Provisions new tenants and grants them to a Tenant Owner.
- Reads (and rarely writes) governance: audit logs, access logs,
  compliance reports.
- Does *not* impersonate tenants (that is `support_admin`'s job).

**Permissions**

- `platform.*`, `tenants.create`, `tenants.read`, `feature_flags.*`,
  `settings.*`, `master_data.*`, `email_templates.*`,
  `notifications.broadcast`, `monitoring.read`, `audit_logs.read`,
  `access_logs.read`, `compliance.read`.
- Cannot: impersonate (`support.*`), change RBAC at the module
  level (`permissions.delete`, `modules.delete`), or hard-delete
  a tenant.

**Daily workflow**

1. Reviews new tenant sign-ups; creates the tenant, sends
   welcome email.
2. Updates master data (new ISO country, new currency).
3. Reviews flagged audit-log entries; escalates to Support Engineer
   if impersonation is required.
4. Posts a status update to customers when a feature flag flips.

**Example**

> *Wednesday* — a new customer closes. The Platform Admin opens
> `/admin/tenants`, types `name`, `slug`, `plan`, and confirms. The
> system creates the tenant, generates the invite for the future
> Tenant Owner, and emails it.

---

### Support Engineer (`support_admin`)

**Responsibilities**

- Impersonates tenant users to debug issues on their behalf.
- Issues account-recovery flows (lost password, lost MFA device).
- Performs cross-tenant lookups for incident investigation.
- Mandatory `reason` on every action. Audited twice (audit +
  access).

**Permissions**

- `support.impersonate`, `support.account_recover`,
  `support.cross_tenant_lookup`, `support.broadcast`.
- `tenantScope: '*'` so cross-tenant reads work.
- Per-admin daily impersonation cap (configured at the platform
  level — `support.dailyCap`, default 20).

**Daily workflow**

1. Reads the day's open support tickets in the ticketing system.
2. For each ticket, opens `/support/impersonate`, types the user
   id, types the reason (mandatory), gets a short-lived
   impersonation token.
3. Reproduces the issue. If it is platform-side, opens a ticket
   to Engineering. If it is user-side, walks the customer through
   the fix.
4. Logs out of the impersonation session; the audit row
   captures the impersonation window.

**Example**

> *Thursday afternoon* — a tenant reports they cannot see their
> dashboard. The Support Engineer impersonates the tenant owner,
> navigates to the dashboard, sees the cache TTL was wrong, opens
> `/feature-flags/<flag>` and flips the rollout to 100 % for that
> tenant. Impersonation ends; audit log records actor, target,
> reason and window.

---

### Tenant Owner (`tenant_owner`)

**Responsibilities**

- Owns one tenant. Created by the Platform Admin during tenant
  provisioning.
- Invites the first Tenant Admin and any other Tenant Owners.
- Sets billing and plan.
- Cannot be demoted to a lower role without their consent; cannot
  be suspended except by the Platform Admin.

**Permissions**

- Every action in every module *within their tenant*.
- `tenants.update` for their own tenant (display name, branding
  tokens); cannot change `slug` (immutable).
- `users.create`, `users.invite`, `users.suspend`,
  `users.update`, `users.delete` (within their tenant).
- `roles.create`, `roles.update`, `roles.delete` (custom roles
  within their tenant — system roles are immutable).
- `feature_flags.update`, `settings.update` (within their tenant).

**Daily workflow**

1. Checks `/auth/me` notifications for any platform-wide
   announcements.
2. Reviews the tenant's audit log (read-only) for the past 24 h.
3. Reviews billing usage; upgrades the plan if needed.
4. Approves new roles or custom permission requests from Tenant
   Admins.

**Example**

> *Friday morning* — the Tenant Owner invites a new COO. They
> open `/tenants/<id>/users`, enter the email, set the role to
> `tenant_owner`. The system sends the invite, the COO accepts,
> and they are now a peer Tenant Owner.

---

### Tenant Admin (`tenant_admin`)

**Responsibilities**

- Operates the tenant day-to-day. The CEO's delegate.
- Invites employees, assigns roles, configures connectors,
  configures notifications.
- Reads (and writes) the tenant's audit log for their tenant.

**Permissions**

- `users.*` (within their tenant), `roles.create` / `roles.update`
  (custom only), `feature_flags.update`, `settings.update`,
  `connectors.*` (within their tenant), `notifications.broadcast`
  (within their tenant), `audit_logs.read` (within their tenant).

**Daily workflow**

1. Reviews pending invitations; approves or revokes.
2. Adds a new connector (e.g. uploads a weekly CSV).
3. Updates notification preferences for a team.
4. Reviews the tenant's last 24 h of audit log entries.

**Example**

> *Monday* — Mia, a Tenant Admin at Acme, uploads the weekly
> shipments CSV. She opens `/connectors`, picks `csv`, names the
> connector "Weekly Shipments", maps the fields, and triggers a
> sync. The connector runs through the queue; the dashboard is
> refreshed by the time Mia is back at her desk.

---

### Manager (custom role built on `tenant_member`)

**Responsibilities**

- Builds dashboards for their team. Schedules reports. Embeds
  widgets on the company intranet.
- Reads everything in their tenant; cannot write users, roles,
  connectors or platform configuration.

**Default permissions**

- `dashboards.*`, `reports.*`, `embed.create`, `analytics.read`,
  `connectors.preview` (cannot `connectors.create`),
  `notifications.read`.

**Daily workflow**

1. Opens the dashboard assigned to their team.
2. Drags a new chart onto the layout; saves; the dashboard emits
   `dashboard:updated` over WebSocket to other open tabs.
3. Schedules a weekly CSV report to be emailed to their team.
4. Embeds a chart on the company intranet via `/embed/sign`.

**Example**

> *Tuesday* — A regional manager at Acme opens the dashboard,
> adds a chart of "On-Time Delivery % by Region", saves, then
> clicks "Embed". The platform returns a short-lived signed URL;
> the manager pastes it into the intranet CMS.

---

### Analyst (custom role built on `tenant_member`)

**Responsibilities**

- Reads dashboards and runs reports. Cannot build dashboards or
  embed widgets.
- Suitable for data-curious employees who need read access.

**Default permissions**

- `dashboards.read`, `reports.read`, `reports.run`,
  `analytics.read`, `notifications.read`.

**Daily workflow**

1. Reads their team's dashboards.
2. Runs a report (CSV download or email).
3. Reads notifications.

**Example**

> *Wednesday* — An analyst at Acme opens the Monday dashboard,
> runs the "Last 30 Days" report, downloads the CSV, and emails
> it to the regional VP.

---

### Viewer (custom role built on `tenant_member`)

**Responsibilities**

- Read-only access to a small set of dashboards.
- No report runs, no embed, no configuration.

**Default permissions**

- `dashboards.read` (for specific dashboards the role is granted
  access to), `notifications.read`.

**Daily workflow**

1. Opens the assigned dashboard.
2. Reads notifications.

**Example**

> *Daily* — A regional VP at Acme opens their dashboard on a wall
> display. They never log into anything else.

---

## Cross-Persona Interactions

| From → To | Action | Audit-log entry |
| --- | --- | --- |
| Platform Admin → Tenant | Provisioning | `module: 'iam.tenants', action: 'create', actor: <admin>` |
| Support Engineer → Tenant User | Impersonation | `module: 'support', action: 'impersonate', actor: <se>, target: <user>, reason: ...` |
| Tenant Owner → Tenant User | Invitation | `module: 'iam.users', action: 'invite', actor: <owner>` |
| Tenant Admin → Role | Custom role creation | `module: 'iam.roles', action: 'create', actor: <admin>` |
| Manager → Dashboard | Save | `module: 'analytics.dashboards', action: 'update'` |
| Support Engineer → Account recovery | Reset | `module: 'support', action: 'account_recover', reason: ...` |

Every row in this table is a row the `audit` plugin already emits;
Sprint 8 persists them (originally Sprint 7, re-scoped — see
[`phases/sprint-7.md`](./phases/sprint-7.md)). Two of them (the
impersonation rows) are emitted to *both* the audit log and the access
log.

## Real-world Examples

### Example 1 — Tenant onboarding to first dashboard in 30 minutes

Acme closes a contract at 09:00. Sam (Platform Admin) creates the
tenant at 09:05 and sends the invite to Alex. Alex accepts at 09:10
and lands in `/auth/me`. Alex invites 12 regional managers at 09:15
and assigns `tenant_admin` to two of them. Mia (Tenant Admin)
uploads the weekly shipments CSV at 09:25; the connector syncs by
09:27. Mia's colleague builds a dashboard at 09:30. Total time
under 30 minutes.

### Example 2 — Cross-tenant incident investigation

A customer reports their dashboard is missing charts. The Support
Engineer impersonates a Tenant Owner, opens `/audit-logs` filtered
to the past hour, sees the connector's `delete` event at 11:42,
traces it to a misclick, restores the connector, and ends the
impersonation session. The entire incident is recorded twice
(audit + access) with a mandatory reason that the customer can
see in their own audit log later.

### Example 3 — Quarterly compliance review

The compliance officer (a Platform Admin with a `compliance.read`
scope) opens `/compliance/export`, requests a JSONL export for
"all tenants, last 90 days, every event". The system streams the
result to S3, the officer downloads it, and runs the GDPR
checklist offline.

## Best Practices

| Do | Why |
| --- | --- |
| **Use the persona vocabulary in every spec.** | Consistent vocabulary makes plans diff-able and demos rehearsable. |
| **Read this doc before opening a sprint plan.** | Every sprint serves one or more personas; the sprint scope must include the personas it serves. |
| **Treat `support_admin` impersonation as a privileged action.** | Mandatory reason, audit + access logged, daily cap. The platform will not soften this. |
| **Give custom roles a name that maps to a real job title.** | `Manager`, `Analyst`, `Viewer` map to real jobs; `role_42` does not. |
| **Audit-log every cross-persona interaction.** | Cross-tenant actions are the highest-risk surface. Two logs for impersonation. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Confusing Platform Admin and Super Admin** | Platform Admin manages configuration; Super Admin owns the platform. The permission sets differ. |
| **Allowing Support Engineers to *create* resources** | They can impersonate and read; they cannot own data. `support_admin` is a read + impersonate role, not a write role. |
| **Creating a custom role that duplicates a system role** | The system role is already seeded with the correct permissions; duplicating creates a maintenance burden. |
| **Letting a Tenant Owner change their own `slug`** | `slug` is immutable by design (per `iam/tenants/README.md`). |
| **Skipping the impersonation reason** | The reason field is mandatory; the audit row is meaningless without it. |

---

## How a New Engineer Should Use This Document

1. Find your persona in the *Personas* section during Stage 1 of
   [`01-getting-started.md`](./01-getting-started.md#stage-1--see-it-run--30-min).
2. Read your responsibilities, permissions and a daily workflow.
3. As you write code, ask: *which persona is calling this endpoint?*
4. When you finish a sprint, open the matching persona's *Daily
   workflow* and verify your deliverable makes a real workflow
   step easier.

---

## What This Document Is Not

- Not a UI spec. Personas do not define screen layouts; they define
  *intent*.
- Not a permissions matrix. The permission keys and actions are in
  [`03-product-roadmap.md`](./03-product-roadmap.md) and the
  permissions module README; this document explains *who uses them*.
- Not a story. Personas are stable; stories change every sprint.

---

## Summary

The platform has nine personas across two audiences. The Admin Portal
serves Platform Owner / Super Admin, Platform Admin, and Support
Engineer. The Tenant Portal serves Tenant Owner, Tenant Admin,
Manager, Analyst and Viewer. Every persona has a system role (Sprint
3), a permission set, a daily workflow, and an example. Cross-persona
interactions are the highest-risk surface; they are audited twice
when they cross tenants.

## Key Takeaways

- **Two audiences, one backend.** Admin Portal and Tenant Portal
  share `src/`; what differs is the JWT audience and the role.
- **Nine personas, six system roles.** Manager / Analyst / Viewer
  are built on `tenant_member` via custom roles.
- **Impersonation is privileged and doubly-logged.** Support
  Engineers impersonate, never own.
- **Custom roles must map to a real job title** or the platform
  accumulates dead RBAC.

## Interview Preparation

### Common Questions

- "Walk me through the personas you would design for in a
  multi-tenant SaaS analytics platform."
- "Why is Support Engineer a separate role from Platform Admin?"
- "How do you prevent Support Engineers from going rogue?"
- "What is the difference between a Tenant Owner and a Tenant
  Admin?"
- "How do you decide between a system role and a custom role?"

### Sample Answers

- **"Walk me through the personas."** — Two audiences. *Our own
  team* runs the Admin Portal: Platform Owner (founder,
  irremovable), Super Admin (anyone holding `super_admin`),
  Platform Admin (configuration), Support Engineer
  (impersonation). *The customer's team* runs the Tenant Portal:
  Tenant Owner (CEO), Tenant Admin (operations), Manager
  (dashboards), Analyst (reports), Viewer (read-only dashboards).
  Six system roles are seeded in Sprint 3; Manager / Analyst /
  Viewer are custom roles built on `tenant_member`.

- **"Why is Support Engineer separate from Platform Admin?"** —
  Because Support Engineer is *read-mostly and impersonates*, while
  Platform Admin *writes platform configuration*. Mixing the two
  means a single compromised account can both impersonate tenants
  *and* change platform settings. Separation is enforced by
  permission scopes and by the `support.impersonate` permission
  which Platform Admin does *not* hold.

- **"How do you prevent Support Engineers from going rogue?"** —
  Three controls: (1) every impersonation requires a mandatory
  `reason`; (2) impersonation is logged twice (audit + access log)
  and the customer can see their own audit rows; (3) a per-admin
  daily cap on impersonations is configured at the platform level.

- **"Tenant Owner vs Tenant Admin?"** — Owner is the CEO / primary
  account; can change billing, can demote admins. Admin is the
  day-to-day operator; can invite users, configure connectors,
  cannot change billing. The split exists so the platform never
  needs to ask "is this the customer's decision-maker?" — the role
  carries the answer.

- **"System role vs custom role?"** — System roles are seeded in
  code (`roles.seed.js`, Sprint 3) and immutable. Custom roles are
  per-tenant; tenants create them with a name that maps to a real
  job title (Manager, Analyst, Viewer). Custom roles inherit the
  `tenant_member` baseline and add or remove specific permissions.

### Real-World Examples

- A sales engineer asks "what does our typical customer's first day
  look like?" They point at Acme Logistics in
  [`04-business-flow.md`](./04-business-flow.md) and the persona
  vocabulary in this doc.
- An interviewer asks "design the permission model for a
  multi-tenant SaaS analytics platform." They answer with the
  permission key shape (`<module>.<action>`), the seed list of
  six system roles, the cache key (`iam:rbac:<scope>`), and the
  three layers of tenant isolation.

### Common Mistakes

- Conflating "Platform Admin" with "Super Admin". The names sound
  similar; the responsibilities and permissions differ.
- Skipping the impersonation reason. The reason field is mandatory.
- Designing a custom role that overlaps a system role. Use the
  system role.
- Treating personas as a UI concern. Personas are an authorisation
  concern; the UI follows the persona, not the other way around.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`TEMPLATE.md`](./TEMPLATE.md) — the documentation standard
- [`STATUS.md`](./STATUS.md) — daily-read project state
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`02-project-vision.md`](./02-project-vision.md) — the *why* behind
  every persona
- [`03-product-roadmap.md`](./03-product-roadmap.md) — when each
  persona's permissions ship
- [`04-business-flow.md`](./04-business-flow.md) — end-to-end story
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the personas are
  encoded in middleware
- [`DECISIONS.md`](./DECISIONS.md) — why roles are data
- [`phases/sprint-1.md`](./phases/sprint-1.md) →
  [`phases/sprint-3.md`](./phases/sprint-3.md) — auth + IAM + RBAC
- [`src/modules/iam/README.md`](../../src/modules/iam/README.md) —
  IAM umbrella

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)