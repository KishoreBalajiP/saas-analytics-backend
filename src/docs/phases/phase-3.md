# Phase 3 — Enterprise Features (Future)

> **WHAT this is:** the record of Phase 3 — KMS, WebAuthn, multi-region,
> SIEM, hash-chain audit, OAuth/SAML SSO, SCIM 2.0, MongoDB / Google
> Sheets connectors, push + outbound-webhook notifications, PDF / XLSX
> reports, anomaly detection and Prometheus `/metrics`.
> **WHY it exists:** enterprise procurement teams ask for these
> features by name. Documenting them once with hooks and owners means
> no one re-discovers the list when a customer asks.
> **HOW to use it:** read *Planned Deliverables*; each item has a hook
> already in the code.
> **WHEN to update it:** when a Phase 3 deliverable moves from
> *Future* to *Planned* (i.e. when a sprint plan opens).
> **WHERE it lives:** `src/docs/phases/phase-3.md`.

---

## Purpose

> **WHAT this is:** the record of Phase 3 — the enterprise feature
> set.
> **WHY it exists:** enterprise procurement teams ask for these
> features by name; documenting them once means no one re-discovers
> the list.
> **HOW to use it:** read *Planned Deliverables*; each has a hook
> already in the code.
> **WHEN to update it:** when a Phase 3 deliverable moves from
> *Future* to *Planned*.
> **WHERE it lives:** `src/docs/phases/phase-3.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Enterprise sales engineer** | Has the canonical answer to "do you support X?". |
| **PM** | Has the list to plan Phase 3 sprints. |
| **Tech lead** | Has the hook map to know what existing code is ready for the upgrade. |

## Current Status

> **Status:** `Future`.
> **Sprint:** No sprint plan exists; the hooks do.
> **Owner:** Engineering team (when Phase 2 closes).

## Business Perspective

The mid-market customer buys Phase 2. The enterprise customer buys
Phase 3. The list below is the smallest set that closes enterprise
procurement: SSO, SCIM, audit retention, KMS, multi-region.

## Technical Perspective

Every Phase 3 deliverable has a **hook** in the Phase 1/2 codebase.
The implementation is a slot-fill, not a rewrite.

| Deliverable | Existing hook |
| --- | --- |
| KMS-managed encryption keys | [`utils/encryption.js#rotateKeys`](../../../src/utils/encryption.js) returns `{ rotated: 0 }` |
| WebAuthn / passkey | `iam/auth/README.md` documents the audience claim |
| OAuth 2.0 / OIDC / SAML SSO | JWT audience infrastructure (Sprint 1) |
| SCIM 2.0 provisioning | `iam/users/` module (Sprint 2) |
| Multi-region | `services/queue.service.js` + `services/cache.service.js` are already provider-agnostic |
| SIEM forwarder | `audit` plugin emits events ([`models/plugins/audit.js`](../../../src/models/plugins/audit.js)) |
| Cold archival to S3 | `services/storage.service.js` already has S3 driver |
| Hash-chain tamper evidence | `audit` plugin events; `models/AuditLog.js` (Sprint 7) gains a `previousHash` field |
| Public compliance endpoint | `compliance/` module route shells (Sprint 7) |
| MongoDB connector | `BaseConnector` framework (Phase 1.1) |
| Google Sheets connector | `BaseConnector` framework |
| Push notifications | `notifications/` module channel registry (Sprint 5) |
| Outbound webhook notifications | `notifications/` module channel registry |
| PDF + XLSX reports | `report.service.js` (Sprint 9) currently produces CSV only |
| Anomaly detection cron | `jobs/anomaly.job.js` is a stub |
| Prometheus `/metrics` | `/monitoring/metrics` route shell (Sprint 8) |

## Planned Deliverables

Each item below ships with the same Definition of Done as a Phase 2
sprint: tests, docs, CI guard updates, `STATUS.md` updated.

1. **KMS-managed encryption keys** — replace env-key fallback in
   [`utils/encryption.js`](../../../src/utils/encryption.js); bump
   envelope to `v2`; ship a migration path for existing ciphertexts.
2. **WebAuthn / passkey** — new `auth/mfa/webauthn/` module; admin
   users (Phase 3) can enroll a passkey.
3. **OAuth 2.0 / OIDC + SAML SSO** — new `auth/sso/` module; per-tenant
   SSO configuration; JIT provisioning from claims.
4. **SCIM 2.0 provisioning** — new `iam/scim/` module; `/scim/v2/Users`,
   `/scim/v2/Groups` endpoints with bearer-token auth.
5. **Multi-region deployment** — region-aware `config/region.js`;
   `services/cache.service.js` and `services/queue.service.js` gain
   per-region scoping; data-residency controls on `Tenant` model.
6. **SIEM forwarder** — new `governance/siem/` module; consumes the
   `audit` events; ships to Splunk / Datadog / Elastic via webhook.
7. **Cold archival to S3** — `jobs/cleanup.job.js` (Sprint 7) ships a
   real implementation that copies records past retention to S3 and
   deletes them from MongoDB.
8. **Hash-chain tamper evidence** — `models/AuditLog.js` (Sprint 7)
   gains a `previousHash` field; insert computes `sha256(previousHash
   + payload)`.
9. **Public compliance endpoint** — `compliance/` route shell (Sprint
   7) gains a public surface via a signed token in the URL.
10. **MongoDB connector** — `BaseConnector` subclass in
    `src/modules/connectors/mongodb/`.
11. **Google Sheets connector** — `BaseConnector` subclass using
    `googleapis`.
12. **Push notifications** — `push` channel in
    `notifications/dispatch.service.js`.
13. **Outbound webhook notifications** — `webhook` channel in the
    same dispatcher.
14. **PDF + XLSX report outputs** — `report.service.js` (Sprint 9)
    gains PDF (`pdfkit`) and XLSX (`exceljs`) renderers.
15. **Anomaly detection cron** — `jobs/anomaly.job.js` becomes real;
    consumes the analytics events and emits alerts.
16. **Prometheus `/metrics`** — `/monitoring/metrics` route shell
    (Sprint 8) becomes a `prom-client` exporter.

## Dependencies

Phase 2 complete.

## Completion Criterion

All 16 deliverables ship; every enterprise procurement checklist the
team has ever received is satisfied.

## Expected Outcome

The platform is enterprise-procurement-ready: SSO, SCIM, audit
retention, KMS, multi-region.

## Real-world Examples

- A customer RFP asks "do you support SAML SSO and SCIM?" The sales
  engineer points at this document and the KMS / multi-region rows
  for the rest of the checklist.

## Best Practices

| Do | Why |
| --- | --- |
| **Treat every hook as a slot-fill, not a rewrite.** | The architecture is ready; the implementation is incremental. |
| **Open Phase 3 sprints one at a time.** | Each item is its own sprint; do not bundle them. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Promising Phase 3 dates in customer contracts.** | Phase 3 is *Future*; no sprint plans exist. |
| **Treating Phase 3 as "the same as Phase 2 but more".** | Phase 3 is enterprise procurement features, not more MVP. Different audience, different criteria. |

---

## Summary

Phase 3 ships 16 enterprise features. Every one has a hook in the
Phase 1/2 codebase; the implementation is a slot-fill, not a rewrite.
Phase 3 opens after Phase 2 closes.

## Key Takeaways

- **16 planned deliverables, all enterprise-grade.** SSO, SCIM,
  audit retention, KMS, multi-region.
- **Every deliverable has a hook in the current codebase.** The
  architecture is ready; the work is incremental.
- **No sprint plans yet.** Phase 3 opens when Phase 2 closes.

## Interview Preparation

### Common Questions

- "What enterprise features does the platform plan to support?"
- "How do you avoid a Phase-3 rewrite?"
- "Why is KMS in Phase 3 and not Phase 1?"

### Sample Answers

- **"Enterprise features?"** — SSO (OAuth/OIDC + SAML), SCIM 2.0,
  audit retention to S3, KMS-managed keys, multi-region deployment,
  SIEM forwarder, hash-chain audit, PDF + XLSX reports, push + webhook
  notifications, MongoDB + Google Sheets connectors, anomaly
  detection, Prometheus `/metrics`.

- **"How do you avoid a rewrite?"** — The architecture has hooks for
  every Phase 3 item today. KMS swaps in at `utils/encryption.js`;
  SSO plugs into the JWT audience infrastructure; SIEM consumes the
  `audit` events already emitted by the `audit` plugin. The work is
  slot-fill, not rewrite.

- **"Why KMS in Phase 3?"** — Phase 1 ships a stable
  `utils/encryption.js` contract; Phase 3 swaps the env-key for KMS.
  Phase 1 does not need KMS to demo auth, RBAC, dashboards, or any
  other Phase 2 feature.

### Real-World Examples

- An enterprise RFP lists "SAML SSO, SCIM, audit retention, KMS,
  multi-region". Every row is in the *Planned Deliverables* list
  above.

### Common Mistakes

- Promising Phase 3 dates. The phase is *Future*; no sprint plans
  exist.
- Treating the *hooks* as the *implementation*. They are slots, not
  features.

## Related Documents

- [`../03-product-roadmap.md`](../03-product-roadmap.md) — phase-by-phase plan
- [`../05-user-journey.md`](../05-user-journey.md) — enterprise personas
- [`phase-2.md`](./phase-2.md) — previous phase
- [`phase-4.md`](./phase-4.md) — next phase
- [`../DECISIONS.md`](../DECISIONS.md) — postponed decisions

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 3 — Enterprise Features (Future)
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)