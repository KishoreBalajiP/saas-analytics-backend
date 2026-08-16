# Lovable Master Prompt — SaaS Analytics Platform Frontend

> **Paste this entire document into Lovable to build the complete frontend against the verified backend.**
> **Backend base URL (development):** `http://localhost:8080`
> **All paths are prefixed with `/api/v1`.**
> **Authentication modes:** Tenant JWT, Admin JWT, `X-Api-Key` (external), embed token (public).
> **Refresh token is set as `HttpOnly` cookie `saas_session` by the backend automatically — never read it from JS.**

---

## 1. Tech Stack (mandatory)

- **React 18 + TypeScript** (strict mode)
- **Vite** as the build tool
- **React Router v6** for routing
- **TanStack Query** (React Query) for server state, caching, and polling
- **Axios** (or `fetch` wrapper) as the HTTP client
- **Zod** for request/response validation at the type boundary (optional but recommended)
- **react-hook-form + zod** for forms (or controlled state — pick one)
- **shadcn/ui + Tailwind CSS** for components
- **Recharts** (or Chart.js) for chart widgets (bar, line, area, pie)
- **lucide-react** for icons
- **react-hot-toast** (or sonner) for toast notifications
- **zustand** or React Context for auth/session state — pick **one**
- **No localStorage for tokens** — the backend issues HttpOnly cookies; store only `accessToken` in memory

## 2. Environment

Create a `.env` file with:

```
VITE_API_BASE_URL=http://localhost:8080
VITE_API_PREFIX=/api/v1
```

## 3. Backend Authentication Model (READ THIS FIRST)

The backend uses **three distinct authentication modes**. Your axios/fetch client must support all three.

| Mode | Header(s) | Audience |
| --- | --- | --- |
| **Tenant JWT** | `Authorization: Bearer <accessToken>` + (login only) `X-Tenant-Id: <slug>` | `/auth/*`, `/users/*`, `/connectors/*`, `/analytics/*`, `/dashboards/*`, `/reports/*`, `/alerts/*`, `/notifications/*`, `/api-keys/*`, `/embed/tokens/*` |
| **Admin JWT** | `Authorization: Bearer <accessToken>` (admin audience) | `/admin-auth/*`, `/admin/*`, `/tenants/*`, `/roles/*`, `/permissions/*`, `/monitoring/*`, `/audit-logs/*`, `/access-logs/*`, `/compliance/*`, `/support/*` |
| **External API Key** | `X-Api-Key: <prefix>.<secret>` | `/external/*` |
| **Embed token** | **No header** — token in URL path | `GET /embed/:token` |

Refresh flow:
- On `POST /auth/login`, `/auth/refresh`, `/admin-auth/login`, `/admin-auth/refresh` the backend sets `Set-Cookie: saas_session=<refreshToken>; HttpOnly; Secure; SameSite=Lax`. **Do not read this cookie from JS.**
- The browser will automatically send it on `/auth/refresh` and `/auth/logout`.
- On a 401 response to any authenticated request, call `POST /auth/refresh` once. If it also returns 401, redirect to login.

Tenant resolution:
- For **tenant-portal login**, the frontend must send `X-Tenant-Id: <slug>` header on `POST /auth/login`. **Do not** send it on other endpoints.
- For **admin-portal login**, do **not** send `X-Tenant-Id`.

## 4. Response Envelope (every endpoint)

```ts
interface ApiResponse<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  meta?: Record<string, unknown>;   // pagination + extra
  timestamp: string;
}

interface ApiError {
  success: false;
  statusCode: number;
  message: string;
  code?: string;
  errors?: Array<{ field: string; message: string }>;
  timestamp: string;
}
```

Paginated lists return `data: T[]` and `meta: { page, limit, total, pages }`.

## 5. Core API Service Layer

Create these modules (one per resource):

- `src/api/client.ts` — axios instance with `baseURL: VITE_API_BASE_URL`, `withCredentials: true`, response interceptor that:
  - On 2xx returns `response.data.data`
  - On 4xx/5xx throws an `ApiError` with `code`, `errors`, `statusCode`
- `src/api/auth.ts` — `loginTenant`, `loginAdmin`, `refresh`, `logout`, `me`, `forgotPassword`, `resetPassword`, `enrollMfa`, `verifyMfa`
- `src/api/connectors.ts` — `listTypes`, `list`, `get`, `create`, `update`, `remove`, `validate`, `listRows`, `previewFile` (CSV or XLSX), `syncFile`, `syncMongoDB`
- `src/api/analytics.ts` — `query`, `listQueries`, `getQuery`, `export`
- `src/api/dashboards.ts` — `list`, `get`, `create`, `update`, `publish`, `duplicate`, `share`, `revokeShare`, `remove`, `execute`
- `src/api/widgets.ts` — `list`, `get`, `create`, `update`, `remove`, `execute`
- `src/api/reports.ts` — `list`, `get`, `create`, `update`, `run`, `remove`, `download`
- `src/api/alerts.ts` — `list`, `listAllEvents`, `get`, `create`, `update`, `remove`, `evaluate`, `listEvents`
- `src/api/notifications.ts` — `list`, `unreadCount`, `markRead`, `markAllRead`, `remove`, `getPreferences`, `updatePreferences`
- `src/api/apiKeys.ts` — `list`, `get`, `create`, `update`, `revoke`
- `src/api/embed.ts` — `list`, `get`, `create`, `revoke`, plus a thin wrapper for the **public** `getEmbed(token)`
- `src/api/externalApi.ts` — `listDatasets`, `getDataset`, `queryDataset`, `listDatasetRows`, `getDashboard`
- `src/api/admin.ts` — all `/admin/*`, `/tenants/*`, `/roles/*`, `/permissions/*`, `/audit-logs/*`, `/access-logs/*`, `/compliance/*`, `/support/*`, `/monitoring/*` methods
- `src/api/masterData.ts` — `list(catalogue)`, `get(catalogue, id)`, `create`, `update`, `remove`

All requests that mutate state **must** include `X-Idempotency-Key: <uuid>` for safety.

## 6. Routing & Layout

```
/                              → redirect by auth state
/login                         → tenant login
/login/forgot                  → forgot password
/login/reset?token=...         → reset password
/                              → authenticated shell
  /dashboard                    → overview KPIs (analytics queries)
  /datasets                     → connector list + create
  /datasets/:id                 → connector detail + rows + field mapping
  /datasets/:id/preview         → upload + preview
  /datasets/:id/sync            → upload + sync (CSV/XLSX) or sync MongoDB
  /analytics                    → query builder (connectors + filters + metrics + groupBy)
  /dashboards                   → list
  /dashboards/new               → builder
  /dashboards/:id               → viewer (all widgets)
  /dashboards/:id/edit          → builder + widget editor
  /reports                      → list + create
  /reports/:id                  → detail + history + download
  /alerts                       → list + create
  /alerts/:id                   → detail + events + evaluate
  /notifications                 → inbox
  /profile                      → self + MFA
  /api-keys                     → list + create (show secret once!)
  /api-keys/:id                 → detail + revoke
  /embed                        → token list + create (for published dashboards only)
  /embed/:id                    → token detail + revoke
/admin/login                   → admin login
/admin/                        → admin shell
  /admin/dashboard              → counts + recent audit
  /admin/tenants                → tenant CRUD
  /admin/tenants/:id            → detail + members + settings + lifecycle
  /admin/admins                 → admin CRUD
  /admin/roles                  → roles + permissions
  /admin/permissions            → module catalogue
  /admin/audit-logs             → search + export
  /admin/access-logs            → search + top paths/errors
  /admin/compliance             → requests CRUD
  /admin/support                → impersonation, recovery, broadcast
  /admin/monitoring             → health probes
```

### Route guards
- `RequireTenantAuth` — checks `/users/me` once at app boot; redirects to `/login` if 401.
- `RequireAdminAuth` — checks `/admin-auth/me` at app boot; redirects to `/admin/login` if 401.
- `RequirePermission(perm)` — calls `/users/me` (tenant) or `/admin-auth/me` (admin) to read `permissions[]`. The backend remains authoritative; this is UX-only.

## 7. Tenant Application Pages (implement all)

### Login (`/login`)
- Form: `email`, `password`, optional `mfaToken`.
- On submit, read the **tenant slug** from a "subdomain input" at the top of the page (or a tenant switcher) and pass as `X-Tenant-Id` header.
- On success, store `accessToken` in memory only. Redirect to `/dashboard`.

### MFA flow
- If `mfaRequired` returned from `/auth/login`, show a second screen asking for the 6-digit code, re-submit with `mfaToken`.

### Password reset
- `/login/forgot` → form with email, calls `/auth/password/forgot`. Always shows success (backend is opaque).
- `/login/reset` → reads `?token=…` from URL, calls `/auth/password/reset`.

### Tenant dashboard (`/dashboard`)
- Three top KPI cards (queries against `/analytics` with metrics = `count` or `sum`).
- Recent connectors list (last 5 from `/connectors`).
- Recent notifications badge (from `/notifications/unread-count`).

### Dataset / connector management
- `/datasets`: table with name, type, status, lastSyncedAt, rowCount (from `/connectors`). "New" button.
- New connector modal:
  - Select type (radio from `/connectors/types`).
  - Type-specific config form:
    - **csv / xlsx:** name only.
    - **mongodb:** name + URI + database + collection + optional filter JSON.
    - **webhook:** name + signingSecret + toleranceSeconds + requireTimestamp.
  - On create → POST `/connectors`. 201 returns `webhookToken` for webhook type — show it once.
- `/datasets/:id`: detail with config summary + rows + field mapping. Tabs: Overview / Rows / Field Mapping / Sync History.

### CSV upload (`/datasets/:id/preview` or `/sync`)
- For type `csv` or `xlsx`:
  - Drag/drop file zone with `.csv | .txt | .xlsx | .xls` accept.
  - "Preview" button → `POST /connectors/:id/preview` (multipart `file`). Shows `fields[]` and `sample[]`.
  - Field mapping editor: source → target dropdown (server-side mapping via PATCH `/connectors/:id` with `fieldMapping`).
  - "Sync" button → `POST /connectors/:id/sync` (multipart). 202 with `{ accepted: true }` — show toast "Sync queued" + link to dashboard.
- For type `mongodb`:
  - Form: URI + database + collection + filter (JSON).
  - "Validate" → `POST /connectors/:id/validate`.
  - "Sync now" → `POST /connectors/:id/sync-mongodb` (no file).

### Dataset explorer (`/datasets/:id`)
- Tab "Data" → server-paginated table from `GET /connectors/:id/rows`. No aggregation here.
- Tab "Preview" → preview result (cached client-side).

### Analytics / query interface (`/analytics`)
- Left: connector picker (from `/connectors`).
- Center: query builder
  - Filters: dynamic array of `{ field, op: eq|neq|in|nin|gt|gte|lt|lte|exists, value }`.
  - Date range: `{ from, to }` pickers.
  - Metrics: dynamic array of `{ field, op: count|sum|avg|min|max, alias }`.
  - Group by: multi-select of fields.
  - Order by: `{ field, dir }`.
  - Pagination: page + limit.
- Right: live results table + total + cached indicator + "Run" button.
- "Save as query" → POST `/analytics/queries` (optional) or just keep the URL.

### Dashboard builder (`/dashboards/new` or `/dashboards/:id/edit`)
- Name, description, status (draft / published / archived), layout.
- Add widget modal: name + type (kpi/table/bar/line/area/pie) + datasetId + query + visualization + position.
- Drag-to-rearrange widgets on a 12-column grid.
- "Save" → POST/PATCH `/dashboards/:id` or `/dashboards`.
- "Publish" → `POST /dashboards/:id/publish` (must be draft).
- "Share" → `POST /dashboards/:id/share` with email + role=viewer.

### Dashboard viewer (`/dashboards/:id`)
- Grid of widgets.
- Each widget calls `GET /dashboards/:id/widgets/:widgetId/execute` and renders chart via Recharts.
- Show partial failures per widget (the response includes `error?: { message, code }`).
- "Full screen" button + "View source" (builder).

### Reports (`/reports`)
- List with status badges (draft, published, running, ready, failed).
- Create wizard: source = widget (pick from `/dashboards/:id/widgets`) or query (raw query JSON); format = json/csv/xlsx; schedule = enabled + cron + timezone + recipients[].
- Detail page: runs table with status + download button.

### Alerts (`/alerts`)
- List with enabled toggle.
- Create wizard: datasetId + condition (`field`, `op`, `value`) + source query/widget + schedule + cooldownMinutes + notification channels.
- Detail: events table + "Evaluate now" button.

### Notifications (`/notifications`)
- Inbox table with unread badge.
- "Mark all read" button.
- Preferences page: email/in_app toggles.

### Profile (`/profile`)
- Edit name, timezone, locale.
- "Enroll MFA" if `mfaEnabled === false`: shows QR code + secret.

### API key management (`/api-keys`)
- List with prefix, scopes, expiresAt, lastUsedAt.
- "Create" modal: name + multi-select scopes + optional expiresAt.
- **On create**: show the full secret ONCE with copy button + prominent warning. Never store it client-side beyond the response. Forbid refresh after navigation.
- Revoke action with confirmation dialog.

### Embed management (`/embed`)
- List with dashboard name, expiresAt, status.
- "Create" modal: select a **published** dashboard (from `/dashboards?status=published`) + optional widgetId + ttlSec.
- **On create**: show the token ONCE with copy button + warning.
- "Revoke" action.
- A "Preview" button opens `/embed/:token` in an iframe (sandboxed, no credentials) to show the rendered dashboard.

## 8. Admin Application Pages

Mirror the tenant UX but using the admin API. Use a distinct layout/shell.

### Admin login (`/admin/login`)
- Same form but **no** `X-Tenant-Id` header.

### Admin dashboard (`/admin/dashboard`)
- System-wide counts: tenants by status, users, sessions, audit events today.
- Recent alerts / support impersonations.

### Tenant management
- Table at `/admin/tenants`.
- Detail at `/admin/tenants/:id` with tabs: Overview / Members / Settings / Audit / Lifecycle (suspend/restore/disable/archive).

### Admin management (`/admin/admins`)
- CRUD with MFA enforcement indicator.

### Roles + permissions (`/admin/roles`, `/admin/permissions`)
- Edit role permission grants; module catalogue.

### Audit logs (`/admin/audit-logs`)
- Filter bar (actor, module, action, resource, tenantId, from, to).
- Table + "Export" button → POST `/audit-logs/export`, poll `GET /audit-logs/export/:exportId` until `status === ready`, then download via `url`.

### Access logs (`/admin/access-logs`)
- Same pattern + "top paths" + "top errors" cards.

### Compliance (`/admin/compliance`)
- List of subject requests with status filter.
- Detail with evidence.

### Support (`/admin/support`)
- "Impersonate" form (userId + reason) with daily-budget counter shown.
- "Stop impersonation" with sessionId.
- "Account recovery" (email + type).
- "Broadcast" form (tenantId or roles, title, body).

### Monitoring (`/admin/monitoring`)
- Cards for each health probe; aggregate summary at top.
- Stubs show "Coming soon" placeholders for queue/scheduler/storage/connectors/metrics.

## 9. UX Standards (non-negotiable)

- Responsive desktop-first layout (≥ 1280 px). Mobile gets a collapsed sidebar.
- Sidebar navigation per shell (tenant + admin).
- Top navigation: tenant switcher (tenant portal), admin selector (admin portal), notifications bell, user menu.
- Breadcrumbs on every detail page.
- Skeleton loaders for every list + detail.
- Empty states with "Get started" CTAs (no fake data).
- Error states that distinguish 401 (redirect to login), 403 (show "permission required"), 404 (not found), 422 (show field-level errors), 429 (show "rate limited" + retry), 500 (generic error).
- Confirmation dialogs for: delete connector, revoke API key, revoke embed token, delete dashboard, archive tenant, suspend tenant, impersonate.
- Toast notifications on every mutation.
- All forms: accessible labels, keyboard navigation, inline validation.
- No fake API responses — if the endpoint returns 501 (Settings, Feature Flags, Email Templates, some Monitoring probes), show "Coming soon" with a disabled state, never fabricate data.

## 10. Security Rules

1. Never store `accessToken` in localStorage. Store in **memory only** (Zustand or Context).
2. Never log API keys or embed tokens. Redact `Authorization` and `X-Api-Key` in error logs.
3. Use the backend's `HttpOnly` cookie for refresh — do not implement a client-side refresh token store.
4. The 401 → refresh → retry interceptor must only retry once.
5. Never include the `secrets` field in any POST/GET request body for API keys or embed tokens. The backend returns the secret ONCE; your UI must show it once and never persist it.
6. For external API demonstrations: put the `X-Api-Key` header on a server-side proxy or show the curl command — never embed real keys in a public demo.
7. The embed route never sends credentials; the iframe must be sandboxed.

## 11. Backend Stubs to Render as "Coming Soon"

Show a disabled card or banner with "Coming soon — backend not implemented yet" for:

- Settings page (`/settings` or `/admin/settings`)
- Feature Flags page
- Email Templates page
- Monitoring sub-probes: queue, scheduler, storage, connectors, metrics
- Master Data import/export

Never invent write operations on these — the backend will return 501.

## 12. Final Integration Test Plan

Before declaring the frontend done, verify each end-to-end flow:

### Tenant flows
- [ ] Login → land on `/dashboard` with three KPI cards
- [ ] Create CSV connector → upload `sample.csv` → preview → sync → see rows
- [ ] Create XLSX connector → upload `.xlsx` → sync → see rows
- [ ] Create MongoDB connector → validate → sync-mongodb → see rows
- [ ] Create dashboard → add KPI widget → save → execute → see number
- [ ] Create bar widget with groupBy → execute → see chart
- [ ] Publish dashboard → view in `/dashboards/:id`
- [ ] Create report from widget → run → download CSV
- [ ] Create alert with condition → evaluate → see event + notification
- [ ] Create API key → copy secret once → list shows only prefix
- [ ] Create embed token → preview iframe → revoke
- [ ] Test cross-tenant isolation: register tenant B, try to view tenant A's dashboard → expect 404

### Admin flows
- [ ] Admin login → land on `/admin/dashboard`
- [ ] Create tenant → initialize → see owner user
- [ ] Suspend tenant → verify tenant login returns 403
- [ ] List audit logs → export → poll → download
- [ ] Search access logs with filter
- [ ] Create role → grant permissions → assign to user
- [ ] Impersonate user → verify user-scoped token works

### Security
- [ ] Without auth, every protected route redirects to login
- [ ] Wrong tenant slug → 403 or 401
- [ ] Missing scope on external API → 403 INSUFFICIENT_SCOPE
- [ ] Revoked API key → 401 on next call
- [ ] Expired embed token → 401/404 opaque
- [ ] Unpublished dashboard → embed returns 404
- [ ] Connectors never expose secrets in their configSummary

---

**STOP.** Read the entire `frontend-api-contract.md` before writing any API service. Build the API client + auth state first, then pages. Do not invent endpoint names, scopes, permission keys, or connector/widget types — only the ones documented above exist.