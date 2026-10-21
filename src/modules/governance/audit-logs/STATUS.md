# Module — Status

**Status:** ✅ Implemented (roadmap 2.5 - security events, full write-path capture, allow-list payloads, hash chain, denied-request audit)

**Source files**
- `src/models/AuditLog.js` - append-only model (`category`, `severity`, `metadata`, chain fields `seq`/`prevHash`/`hash`/`hashAlg`/`keyId`).
- `src/repositories/auditLog.repository.js` - chained inserts, chain reads, retention purge.
- `src/services/auditLog.service.js` - the single write entry point (`emit`) and reads.
- `src/services/auditConsumer.service.js` + `src/models/plugins/audit.js` + `src/models/plugins/auditPolicy.js` - model-level rows for saves, query updates, deletes and bulk writes, reduced to per-model allow-lists.
- `src/constants/securityEvents.js` + `src/services/securityEvent.service.js` - security event catalogue and `securityEvent()`.
- `src/middleware/audit.middleware.js#auditDenied` - rate-limited `request.denied` events from auth/authz middleware.
- `src/utils/auditPayload.js` (serialisation + redaction), `src/utils/auditChain.js` (sealing), `src/services/auditChain.service.js` (verification), `scripts/ci/verify-audit-chain.js` (read-only operator check).
- Read API: `src/routes/audit-log.routes.js`, `src/controllers/auditLog.controller.js`, exports in `src/services/auditExport.service.js`.

**Tests:** `tests/audit/*.test.js`, `tests/audit-consumer.integration.test.js`, `tests/audit-export.integration.test.js`.

**Operator actions:** insert-only MongoDB credentials for `auditlogs` (see `src/models/AuditLog.js`), `AUDIT_CHAIN_KEY`, a scheduled `node scripts/ci/verify-audit-chain.js --expect-head <seq>:<hash>` run.
