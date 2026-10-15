# Analivo Security Gap Analysis

See the canonical report for evidence and remediation: [ANALIVO_CODEBASE_DISCOVERY_REPORT.md](./ANALIVO_CODEBASE_DISCOVERY_REPORT.md).

## Confirmed source-backed gaps

| ID | Severity | Component | Summary |
|---|---|---|---|
| SEC-001 | High | Embed/CORS | Example configuration allows all embed origins; production value is unknown. |
| SEC-002 | High | Scheduler/jobs | Email, Sheets sync, cleanup and anomaly jobs are explicit no-ops/stubs. |
| SEC-003 | Medium | Settings | Settings route shell returns 501 despite surrounding models/services/UI. |
| SEC-004 | Medium | Connectors | Base/registry architecture and advertised providers do not prove every connector is operational. |
| SEC-005 | Medium | Operations | Production secrets/configuration/deployment parity are unverified. |
| SEC-006 | Medium | Outbound connectors | SSRF/DNS rebinding/metadata/TLS controls require safe provider-specific verification. |
| SEC-007 | Low | Frontend tests/browser | React act warnings and reported #418 are not yet reproduced or attributed. |

No production exploit was attempted. These findings are deliberately separated from verified positive controls such as RBAC/tenant tests, refresh-token replay detection, hashed API keys, encryption utilities, validation, rate limits and audit logging.
