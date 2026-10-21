# 15. Frontend UX and product coherence

**Audience:** frontend engineers and the product owner of the Analivo web experience (public site, onboarding, tenant workspace, platform admin).

**Verdict:** in the audited commits, **the tenant workspace does not work end to end**, even though every frontend API client points at a mounted backend route and the unit tests pass. Three independent defects block the core journey:

1. **Every gated tenant page shows "Permission required", including for the workspace owner.** The tenant profile (`GET /users/me`) returns no permissions (`backend/src/services/user.service.js:42-46`), and the page-level helper denies on an empty list (`frontend/src/lib/permissions/index.ts:46-48`). Datasets, dashboards, analytics, reports, alerts, API keys, embed and notifications are affected ({{FE:perm-gate}}).
2. **Analytics results never render.** The UI reads `result.rows` from a payload whose `data` is already the row array, so every query shows "No data matched" ({{FE:analytics-shape}}).
3. **Dashboard widgets never render data.** The dashboard execution payload nests the engine result one level deeper than the UI reads ({{FE:dashboard-shape}}).

In addition, API keys and embed are broken on the backend (document 09), billing is 403 because its permissions are never seeded (document 13), admins with MFA cannot finish signing in through the UI ({{FE:admin-mfa}}), and the tenant home page always shows a "Something went wrong" card ({{FE:home-error}}). The frontend test suite does not catch any of this because it mocks the transport with shapes the backend does not return ({{FE:tests-mocked}}).

**Production may differ.** These conclusions describe the checked-out commits. Nothing in either repository records what Vercel and Render are running; a five-minute signed-in walkthrough on production (document 20, phase 0) will confirm or refute them.

## 1. Public website (brief §16.1)

| Aspect | Assessment |
|---|---|
| Positioning and claims | Honest. Lists dashboards, analytics, reports and alerts; data sources limited to CSV, XLSX and webhooks; demo numbers labelled "demo"; states that tenant-user MFA is not available (`frontend/src/routes/index.tsx`). No AI, certification or SLA claims |
| Pricing | No pricing page (document 13) |
| Documentation and developer entry points | None; no API reference or embed guide (document 09) |
| Legal and privacy | Policy pages render a shared placeholder template that describes itself as not final, and registration collects no consent, while the product takes registrations and payments ({{FE:legal}}) |
| Navigation and footer | Anchor links on the homepage work; footer links point to existing policy routes |
| SEO metadata | Title and description set; `theme-color` emitted as a `<link>` instead of `<meta>`; no Open Graph or canonical tags; `robots.txt` allows every path including app routes |
| Brand consistency | "Analivo" on public pages; app routes use "— Analytics Console" titles; the backend still names itself "SaaS Analytics Platform" in emails and config defaults |
| Security headers | No CSP or `frame-ancestors` on the frontend, which holds access tokens in memory ({{FE:headers}}) |

## 2. Onboarding (brief §16.2)

| Step | Assessment | Finding |
|---|---|---|
| Registration form | No client-side slug validation; 422 field errors from the backend are hidden; a non-JSON error body can appear as raw markup text in a toast (escaped, not an XSS); the success message says the email was sent even when `verificationSent` is false; the page title says "Join a workspace"; an `analivo.app/` URL prefix is shown although no per-workspace domain exists | {{FE:register-form}} |
| Duplicate submissions | Buttons disable while pending; the backend's concurrent same-slug protection depends on unbuilt production indexes | {{OPS:indexes}} |
| Email verification | Works (`/register?token`), but the token stays in the URL, so a reload re-posts it and shows an error | |
| Resend verification | Implemented; 60 s cooldown | |
| Sign-in after verification | Requires a workspace slug that owners and invited users are never reliably shown | {{FE:slug}} |
| Onboarding checklist | Progress is derived from server data (good); invitations from onboarding are always sent as `Viewer` | |
| First data connection | Upload works; the webhook URL is shown and copied as a relative path (`/webhooks/<token>`), unusable outside the app | {{FE:webhook-url}} |
| First dashboard and first insight | Blocked by the permission gate and the shape defects above | {{FE:perm-gate}}, {{FE:dashboard-shape}} |

## 3. Tenant workspace (brief §16.3)

| Area | Status | Notes |
|---|---|---|
| Navigation and shell | Works; rebuilt on every route change, so each navigation flashes "Restoring your session…" and refetches the profile ({{FE:session-rebuild}}) | Redirect to `/login` drops the requested path |
| Session restore | In-memory access token + HttpOnly refresh cookie; single refresh-and-retry on 401 | A refresh failure can leave the shell "authenticated" with no token ({{FE:refresh-failure}}); every provider mount calls refresh in the same strict rate-limit bucket as login ({{FE:refresh-ratelimit}}); concurrent tabs can trip replay detection and revoke all sessions ({{AUTH:multitab}}); tenant and admin portals share one refresh-cookie name, so signing into one overwrites the other ({{FE:cookie-name}}); cross-site cookie depends on third-party cookies ({{AUTH:third-party-cookie}}) |
| Sign-out | Query cache is not cleared or keyed by tenant, so the next user in the same tab can briefly see the previous tenant's data ({{FE:query-cache}}) | |
| Datasets | Gated (blocked); otherwise CRUD, upload and sync wired | No client size check; backend upload errors surface as 500s |
| Analytics | Blocked; results never render; export drops the format and shows "Export queued (undefined)" ({{FE:export-format}}) | Query builder sends `groupBy` in the wrong shape |
| Dashboards | List/create/delete wired; viewing broken; editor uses a raw JSON textarea; no publish/duplicate/share actions; widget delete without confirmation | |
| Reports | Partially wired; run ids read from a field that does not exist; default query lacks a dataset so runs fail asynchronously; download links unusable with the local storage driver | |
| Alerts | Partially wired; the dataset field is never sent; no UI for schedule, cooldown or recipients | |
| Notifications | Inbox works; preferences are simulated on the backend and read with the wrong key in the UI | |
| API keys | Broken (document 09); the one-time secret is displayed without its prefix, so the copied value cannot authenticate ({{FE:key-prefix}}) | |
| Embed | Broken (document 09) | |
| Billing | 403 (document 13) | |
| Settings, profile | Settings is a "Coming soon" card in the main navigation; profile promises editing it does not provide; no password change ({{FE:settings-placeholder}}) | |
| Workspace switching | Missing; users must sign out and re-enter a slug | |
| Realtime | None (Socket.IO unused) | |

## 4. Platform admin UX (brief §16.4)

| Aspect | Assessment |
|---|---|
| Separation from tenant admin | Clear: separate shell, routes, session provider and token audience |
| Sign-in | Admins with MFA enabled cannot complete sign-in: the UI waits for an `MFA_REQUIRED` error code the backend never sends ({{FE:admin-mfa}}). No forgot-password link; the emailed reset link targets a route that does not exist ({{AUTH:admin-reset-link}}) |
| Navigation gating | Dashboard gated on `monitoring.view` while the API requires `iam.tenants.view`; support gated on a permission admins do not hold ({{ADM:support-ui}}) |
| Destructive actions | Tenant suspend has no confirmation and a hard-coded reason; "Restore" is offered for archived and pending tenants |
| Lists | Admins and access logs fetch only page 1, without filters |
| Audit log | Frontend types expect `actor`, `resource`, `createdAt`; backend sends `actorId`, `resourceType`, `occurredAt`, so actor, resource and time render as "system"/"—"; audit export never shows its download link |
| Compliance | "Coming soon" although backend routes exist |
| Monitoring | Nested probe objects render as the literal "Available"; most probes are placeholders on the backend |
| Admin type values | Frontend union `super_admin`/`platform_admin`/… does not match backend `super`/`platform`/`support` |

## 5. Accessibility and usability (brief §16.5)

Source review only; no automated or assistive-technology testing was possible.

- Mobile navigation drawers (tenant and admin) have no backdrop, Escape handling, focus trap or `inert`, so off-screen links remain tabbable.
- Each tenant nav link contains a description paragraph, which inflates its accessible name.
- Primary submit buttons on register and login force `text-foreground` on `bg-primary`, estimated at about 3.5:1 contrast from the design tokens, below WCAG AA for normal text.
- Error states use icons with text and are not announced (`role="alert"` only on inline field errors).
- Form fields generally have labels (shadcn `Form` components); tables lack captions.

Recommended: run axe in component tests, add a Playwright accessibility smoke test for the main journeys, and fix the drawer and contrast issues in the shared shell and button variants rather than per page.

## 6. Recommendations

1. **Phase 0 hotfixes** (document 20): return permissions from the tenant profile; fix the analytics and dashboard response shapes on one side, with a contract test; fix admin MFA sign-in; clear the query cache on sign-out.
2. **Shared contract.** Generate TypeScript types from backend schemas (or an OpenAPI document) and replace hand-written `types.ts` entries; add contract tests that run the real backend in CI for the main routes.
3. **One session provider** mounted once at the root per audience, with an explicit "service unavailable" state distinct from "signed out", and a tenant-keyed query cache.
4. **Truthful UI:** hide navigation entries for features that return 501 or are not entitled; replace "Coming soon" cards in primary navigation with nothing until the feature exists.
5. **Onboarding:** show and remember the workspace sign-in URL or slug in the verification email and success screen; consider per-workspace subdomains later.
6. **Security headers** on the Vercel deployment (CSP, `frame-ancestors 'none'` except for the embed route, `Referrer-Policy`, `Permissions-Policy`).
7. **Legal readiness:** real privacy policy, terms and subprocessor list reviewed by counsel; consent capture at registration.

## 7. Findings in this area

{{FE:perm-gate}}, {{FE:analytics-shape}}, {{FE:dashboard-shape}}, {{FE:admin-mfa}}, {{FE:query-cache}}, {{FE:home-error}}, {{FE:slug}}, {{FE:session-rebuild}}, {{FE:refresh-failure}}, {{FE:refresh-ratelimit}}, {{FE:cookie-name}}, {{FE:register-form}}, {{FE:legal}}, {{FE:settings-placeholder}}, {{FE:headers}}, {{FE:export-format}}, {{FE:key-prefix}}, {{FE:webhook-url}}, {{FE:tests-mocked}}, {{AUTH:multitab}}, {{AUTH:third-party-cookie}}, {{AUTH:admin-reset-link}}, {{ADM:support-ui}}. Full details are in `19-findings-register.md`.
