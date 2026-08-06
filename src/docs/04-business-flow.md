# 04 — Business Flow

> **WHAT this is:** the canonical end-to-end story of how a customer
> uses the SaaS Analytics Platform, from sign-up to embed.
> **WHY it exists:** a feature list does not explain the product. A
> walkthrough does. This document is what a sales engineer reads
> before a demo and what a new PM reads before writing a spec.
> **HOW to use it:** read it once end-to-end, then keep it open while
> designing or reviewing any feature.
> **WHEN to update it:** when a new persona joins the flow, when an
> existing step changes shape, or when a step's status moves between
> Planned / In Progress / Shipped.
> **WHERE it lives:** `src/docs/04-business-flow.md`.

---

## Purpose

> **WHAT this is:** the canonical end-to-end business flow of the
> SaaS Analytics Platform, from first contact to ongoing usage.
> **WHY it exists:** a feature list does not explain a product; a
> walkthrough does. New PMs, sales engineers and onboarding hires all
> need the same single document that answers *"what does a customer
> actually do, in what order, through which surfaces?"*.
> **HOW to use it:** read it once end-to-end, then keep it open while
> designing or reviewing any feature. Every step references the real
> route file and the sprint that ships it.
> **WHEN to update it:** when a new persona joins the flow, when an
> existing step changes shape, or when a step's status moves between
> Planned / In Progress / Shipped.
> **WHERE it lives:** `src/docs/04-business-flow.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Product manager** | Has the canonical sequence to anchor any spec they write. |
| **Sales engineer** | Has a single document they can rehearse before a demo. |
| **New backend / frontend engineer** | Knows *which* API surface they are building for in the current sprint. |
| **Tech lead** | Has the cross-feature dependency list to plan sprints. |
| **Founder** | Has the customer-journey narrative they can use externally. |
| **Interview candidate** | Has the canonical story to anchor any system-design answer. |

## Current Status

> **Status:** `Planned` — the flow itself is the design; every step is
> currently fail-closed `501` and will ship across Sprints 1–9. The
> doc is updated as each step ships.
> **Sprint:** Sprint 0 (complete); the steps described here ship in
> Sprints 1–9 per the [roadmap](./03-product-roadmap.md).
> **Owner:** Product + Engineering.

## Business Perspective

A customer does not buy features; a customer buys a *journey*. The
SaaS Analytics Platform has one canonical journey, walked through by
**Acme Logistics**, a fictional mid-market shipping company that
needs to give its regional managers their own dashboards without
hiring a data team.

| # | Step | Who | What | Sprint |
| - | --- | --- | --- | --- |
| 1 | Provision tenant | Platform Admin | Acme signs a contract; Platform Admin creates the tenant. | [Sprint 2](./phases/sprint-2.md) |
| 2 | Invite tenant Owner | Platform Admin | Acme's CEO (Alex) is invited to be the first user. | [Sprint 2](./phases/sprint-2.md) |
| 3 | First login | Tenant Owner | Alex logs in, sets MFA, lands in `/me`. | [Sprint 1](./phases/sprint-1.md) |
| 4 | Invite teammates | Tenant Owner | Alex invites 12 regional managers. | [Sprint 2](./phases/sprint-2.md) |
| 5 | Define roles | Tenant Owner | Alex assigns `tenant_admin` to two managers and `tenant_member` to the rest. | [Sprint 3](./phases/sprint-3.md) |
| 6 | Connect CSV | Tenant Admin | A manager uploads the weekly shipments CSV. | [Sprint 6](./phases/sprint-6.md) |
| 7 | Connect webhook | Tenant Admin | The carrier API pushes inbound events to `/webhooks/<connector-id>`. | [Sprint 6](./phases/sprint-6.md) |
| 8 | Build a dashboard | Tenant Member | A regional manager builds a dashboard from the connected data. | [Sprint 9](./phases/sprint-9.md) |
| 9 | Run a report | Tenant Member | The manager schedules a weekly CSV report by email. | [Sprint 9](./phases/sprint-9.md) |
| 10 | Share an embed | Tenant Member | The manager embeds a chart in the company's intranet. | [Sprint 9](./phases/sprint-9.md) |
| 11 | Receive an alert | Tenant Member | When an anomaly fires, the manager gets an in-app + email notification. | [Sprint 5](./phases/sprint-5.md) + [Phase 3](./03-product-roadmap.md#phase-3--enterprise-features-future) |
| 12 | Govern | Platform Admin | The Platform Admin audits every mutation across tenants via `/audit-logs`. | [Sprint 7](./phases/sprint-7.md) |

> **Today:** every numbered step above returns `501`. See
> [`STATUS.md`](./STATUS.md) for the current shipping state. This
> document describes the *target* flow that Sprints 1–9 will deliver.

## Technical Perspective

Every step below ties to a real file in the repository. The flow
reads top-to-bottom; the data ownership, the tenant context and the
permission scope evolve as the actor moves through the system.

```
┌───────────────────────────────────────────────────────────────────┐
│  Acme employees (browser, mobile, intranet embed)                 │
└────────────┬──────────────────────────────────────────────────────┘
             │  HTTPS, WebSocket
             ▼
┌───────────────────────────────────────────────────────────────────┐
│  Express (app.js)                                                 │
│   1. requestIdMiddleware                                          │
│   2. helmet / cors / compression / cookie-parser                  │
│   3. body parsers (limit REQUEST_BODY_LIMIT)                      │
│   4. morgan → pino                                                │
│   5. apiLimiter (global)                                          │
│   6. /api/v1/<route>                                              │
│      a. authenticate / adminAuth  (Sprint 1)                      │
│      b. resolveTenant             (Sprint 1)                       │
│      c. tenantIsolation           (Sprint 2)                       │
│      d. rbac / permission / modulePermission  (Sprint 3)         │
│      e. validateRequest           (validator engine)              │
│      f. audit / accessLog         (Sprint 7)                       │
│      g. controller → service → repository → model                 │
└────────────┬──────────────────────────────────────────────────────┘
             │
             ▼
┌───────────────────────────────────────────────────────────────────┐
│  Side channels (services/cache, services/queue, services/storage, │
│  services/email)                                                  │
└───────────────────────────────────────────────────────────────────┘
```

The middleware order is fixed in `src/app.js`. The future
per-route middleware chain is documented in
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and is enforced by the
`check-routes` CI guard.

## Architecture — The Data Model Around the Flow

```
                ┌──────────────┐
                │   Tenant     │  Acme's root record
                │   t_acme     │  (slug = 'acme', immutable)
                └──────┬───────┘
                       │ 1..n
                       ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   User       │  │   User       │  │   User       │
│   Alex       │  │   Mia        │  │   regional mgr│
│   tenant_admin│ │  tenant_owner│ │  tenant_member│
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │ all three hold  │ every action    │
       │ the same        │ is tenant-      │
       │ tenantScope     │ scoped via      │
       │ on every read   │ tenantScope    │
       ▼                 ▼                 ▼
┌────────────────────────────────────────────────┐
│            tenant-owned collections              │
│   Connector  │ Dashboard │ Report │ Embed │    │
│   AuditLog   │ AccessLog │ Notification │ ...  │
└────────────────────────────────────────────────┘
                       ▲
                       │ every write goes through
                       │ services/queue.* for async
                       │ services/audit.* for capture
                       │
                ┌──────┴───────┐
                │  Role +      │
                │  Permission  │  (Sprint 3 seeds:
                │  iam:rbac:*  │   tenant_owner, tenant_admin,
                │  cached in   │   tenant_member, super_admin,
                │  Redis       │   platform_admin, support_admin)
                └──────────────┘
```

Three things to remember:

1. **Every tenant-owned record carries `tenantId`.** The
   [`tenantScope` Mongoose plugin](../../src/models/plugins/tenantScope.js)
   auto-injects the filter on reads and refuses to save a document
   without one.
2. **Three layers of tenant isolation.** `resolveTenant` (which
   tenant does this request belong to?), `tenantIsolation` (is this
   actor allowed to touch that tenant?), `tenantScope` (does the
   query filter on `tenantId`?). See
   [`backend/multi-tenancy.md`](./backend/multi-tenancy.md) when it
   lands.
3. **Roles and permissions are data, not code.** Sprint 3 seeds the
   system roles and every tenant can extend them. The RBAC cache
   lives at `iam:rbac:<scope>` in the cache layer.

## Real-world Examples

### Step 1 — Platform Admin creates the tenant

**Actor:** Sam (Platform Admin at our company)
**Endpoint:** `POST /api/v1/tenants` (Sprint 2 — currently 501)

```http
POST /api/v1/tenants
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{
  "name": "Acme Logistics",
  "slug": "acme",
  "billing": { "plan": "growth" }
}
```

Expected response (200, envelope):

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "id": "t_01HABCDEFG...",
    "name": "Acme Logistics",
    "slug": "acme",
    "status": "active",
    "createdAt": "2026-08-05T10:00:00.000Z"
  }
}
```

Where in the code:

- Route: [`src/routes/tenant.routes.js`](../../src/routes/tenant.routes.js)
- Controller: `src/modules/iam/tenants/tenant.controller.js`
- Service: `src/modules/iam/tenants/tenant.service.js`
- Repository: `src/modules/iam/tenants/tenant.repository.js`
- Model: `Tenant` with `tenantScope`, `softDelete`,
  `optimisticConcurrency`, `audit` plugins applied.
- Side-channel: an audit-log entry for `module: 'iam.tenants',
  action: 'create', actor: <Sam>` is emitted.

### Step 4 — Alex invites teammates

**Actor:** Alex (Acme's CEO / first user)
**Endpoint:** `POST /api/v1/tenants/{tenantId}/users` (Sprint 2)

```http
POST /api/v1/tenants/t_01HABCDEFG/users
Authorization: Bearer <alex-access-token>
Content-Type: application/json

{
  "email": "mia@acme.com",
  "name": "Mia (Operations)",
  "role": "tenant_admin",
  "invitation": { "expiresInDays": 7 }
}
```

Expected behaviour:

1. Server creates a `User` document with `tenantId: 't_01HABCDEFG'`,
   `passwordHash: null` (invite-only).
2. Server enqueues an outbound email via
   `services/queue.service.js#enqueueEmail`.
3. The email worker (Sprint 1) renders the
   `invitation.email.html` template and sends through
   `services/email.service.js#send`.
4. Mia clicks the link, sets a password, lands in `/auth/me`.

### Step 6 — A manager uploads a CSV

**Actor:** Mia (tenant_admin)
**Endpoint:** `POST /api/v1/connectors` (Sprint 6)

```http
POST /api/v1/connectors
Authorization: Bearer <mia-access-token>
Content-Type: application/json

{
  "type": "csv",
  "name": "Weekly Shipments",
  "config": { "delimiter": ",", "hasHeader": true },
  "schedule": "manual"
}
```

Then:

```http
POST /api/v1/connectors/{connectorId}/sync
Authorization: Bearer <mia-access-token>
```

The connector:

1. Validates the stored config against the live provider
   (`BaseConnector#validate`).
2. Previews the data (`BaseConnector#preview`).
3. Enqueues a sync job via
   `services/queue.service.js#enqueueConnectorSync`. The job carries
   an `idempotencyKey` so retries never ingest twice.
4. A worker (in the same process or another instance) drains the
   queue and writes rows into the tenant-owned `Shipment` collection.

### Step 8 — A manager builds a dashboard

**Actor:** Mia (or any `tenant_member`)
**Endpoint:** `POST /api/v1/dashboards` (Sprint 9)

The dashboard layout is a JSON document stored as the current
version. The frontend builds it with a drag-and-drop editor; the
backend persists it. Every save emits:

- A WebSocket emit on `room: dashboard:<id>` (event
  `dashboard:updated`) so other open tabs re-render.
- A `dashboard:update` audit-log entry.

## Best Practices

| Do | Why |
| --- | --- |
| **Walk this document before writing any spec.** | Every step has a sprint owner and a real route file; specs that ignore the flow create orphans. |
| **Treat the persona names (Sam, Alex, Mia) as the canonical vocabulary** until we have real customers. | Consistent vocabulary across docs, demos and code comments makes onboarding cheaper. |
| **Reference this document in PRs that change a step.** | Reviewers can spot drift from the canonical flow in seconds. |
| **Mark every "Planned" step as such** in commit messages and changelogs. | The flow is the truth; no step ships without it being here. |
| **Keep step numbering stable.** | Step 4 (invite teammates) will be step 4 in every future doc, forever. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Inventing a self-service signup in a spec** | The current flow is *Platform Admin creates tenant* (Sprint 2). There is no self-signup until Phase 4+. Specs that assume otherwise will collide with `tenantScope`. |
| **Adding a "user can do anything" capability** | The platform is RBAC-first; the flow enforces `permission(module, action)` on every mutation. A blanket bypass would defeat `tenantIsolation`. |
| **Treating the embed widget as a backdoor** | The embed token is signed, short-lived, scoped to one dashboard, and revoked the moment the source dashboard is deleted. Embed is for *display*, not *data exfiltration*. |
| **Skipping the audit-log step** | Sprint 7 ships governance as a first-class feature, not an afterthought. Every mutation in the flow above must emit an `audit` event. |
| **Reading this as a sales pitch** | It is an engineering reference. The flow is grounded in real route files, real middleware order, and real sprint plans. |

---

## How a New Engineer Should Use This Document

1. Read it once during Stage 2 of
   [`01-getting-started.md`](./01-getting-started.md#stage-2--understand-the-skeleton--1-h).
2. Whenever you open a sprint plan, find the matching step here and
   read the *Where in the code* block.
3. When in doubt about whether a feature belongs in this codebase,
   ask: *which step does it change, and which sprint is the owner?*
4. When writing a PR that touches a step, link this document from the
   PR description and call out the change to the flow.

---

## What This Document Is Not

- Not a tutorial. There are no step-by-step commands. Read
  [`01-getting-started.md`](./01-getting-started.md) for that.
- Not a marketing one-pager. The fictional company exists to anchor
  the flow, not to advertise the platform.
- Not a wishlist. Every step has a sprint plan; planned-but-not-yet
  is explicitly marked as such.

---

## Summary

The SaaS Analytics Platform has one canonical flow, walked through
by Acme Logistics and a Platform Admin. Twelve steps take Acme from
*no account* to *embed widget on the company intranet*. Every step
ties to a real route file and a sprint plan. Today every step is
`501`; Sprint 0 is complete and Sprints 1–9 will ship the rest.

## Key Takeaways

- **Twelve steps, three personas** (Platform Admin, Tenant Owner,
  Tenant Member). Each step has an owner, a sprint and a real route
  file.
- **Three layers of tenant isolation** (resolveTenant,
  tenantIsolation, tenantScope) defend every step that touches tenant
  data.
- **Roles and permissions are data.** Sprint 3 seeds the system
  roles; tenants extend them.
- **Every mutation emits an audit event** (Sprint 7 wires this; the
  `audit` plugin already exposes the events).

## Interview Preparation

### Common Questions

- "Walk me through how a new customer goes from contract to first
  dashboard."
- "How do you keep tenant data isolated across the whole journey?"
- "Where would you add self-service signup?"
- "What is the role of the Platform Admin vs the Tenant Owner?"
- "How do you decide what is the Tenant Owner's job vs the
  Platform Admin's job?"

### Sample Answers

- **"Walk me through how a new customer goes from contract to first
  dashboard."** — Twelve steps: Platform Admin creates the tenant,
  invites the first user, the user logs in with MFA, invites
  teammates, defines roles, connects a CSV and a webhook, builds a
  dashboard, runs a report, embeds a widget, receives an alert, and
  is visible to the Platform Admin via the audit log. Each step has
  a sprint and a route file in the repo; the doc links both.

- **"How do you keep tenant data isolated across the whole journey?"**
  — Three layers. (1) `resolveTenant` decides which tenant the
  request belongs to (priority: header → JWT claim → subdomain).
  (2) `tenantIsolation` checks the actor is allowed to touch that
  tenant's resources. (3) `tenantScope` Mongoose plugin auto-injects
  the tenant filter on every read and refuses to save without one.
  Every step in the flow above touches all three layers; forgetting
  one is a bug, not a security incident.

- **"Where would you add self-service signup?"** — Not in Phase 2.
  The flow is *Platform Admin creates tenant* (Sprint 2) because we
  need billing and contract controls before customers can self-serve.
  Self-service lands in Phase 4+ once we have a billing layer and
  can hand off the tenant-creation step to the customer. Adding it
  in Phase 2 would mean shipping it without billing, which is worse
  than not shipping it.

- **"Platform Admin vs Tenant Owner?"** — Platform Admin is *us*
  (the company running the platform); they see every tenant, manage
  platform configuration and audit cross-tenant activity. Tenant
  Owner is the customer's CEO; they see *only* their tenant, manage
  their users, roles, settings and connectors. The same backend
  serves both; what differs is the role's permission scope and the
  JWT audience.

### Real-World Examples

- A sales engineer preparing a demo opens this document, picks step 6
  ("connect CSV") and step 8 ("build dashboard"), and rehearses
  only those two screens. The rest of the flow is the
  *back-story* the prospect can ask about.
- A PM is asked "should we add SSO before or after MFA enforcement?"
  They look at step 3, see MFA is required, and answer: *SSO can
  replace email + password but not MFA; we ship email+MFA first,
  SSO in Phase 3*.

### Common Mistakes

- Treating the flow as a sales deck. The persona names are *vocabulary
  aids*, not customer-facing copy.
- Adding steps to the flow that are not yet planned. If a feature is
  not in the roadmap, it is not in the flow.
- Skipping the audit-log step. Governance is a feature, not an
  afterthought.
- Forgetting that the embed widget is signed and scoped; it is not
  a backdoor for data exfiltration.

## Related Documents

- [`README.md`](./README.md) — documentation homepage
- [`TEMPLATE.md`](./TEMPLATE.md) — the documentation standard
- [`STATUS.md`](./STATUS.md) — daily-read project state
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`02-project-vision.md`](./02-project-vision.md) — the *why* behind
  every step
- [`03-product-roadmap.md`](./03-product-roadmap.md) — when each
  step ships
- [`05-user-journey.md`](./05-user-journey.md) — persona-by-persona
  capabilities (next in the priority queue)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions
- [`phases/sprint-0.md`](./phases/sprint-0.md) →
  [`phases/sprint-9.md`](./phases/sprint-9.md) — per-step sprint plans

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)