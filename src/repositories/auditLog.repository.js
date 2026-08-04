/**
 * Audit Log Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable, append-only data-access surface for the audit trail. Reads
 *   service the `/audit-logs` API. Writes happen via the audit service.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - insert(event), insertMany(events)
 *   - list(filters), findById, listByModule(module, filters)
 *   - countByAction / countByActor (analytics)
 *   - retentionPurge({ before })   (privileged, queued)
 *
 * CODING GUIDELINES
 *   - NO update / delete except through `retentionPurge` and only when
 *     the retention window has elapsed (Phase 3 setting).
 *   - Lean returns for reads; raw insert for writes (avoids fight with
 *     Mongoose middleware in hot path).
 *
 * FUTURE EXTENSION
 *   - Time-series collection (Mongo 5.0+).
 *   - Tamper-evidence hash chain.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const insert = notImplementedStub('auditLog.repository', 'insert');
export const insertMany = notImplementedStub('auditLog.repository', 'insertMany');
export const list = notImplementedStub('auditLog.repository', 'list');
export const findById = notImplementedStub('auditLog.repository', 'findById');
export const listByModule = notImplementedStub('auditLog.repository', 'listByModule');
export const countByAction = notImplementedStub('auditLog.repository', 'countByAction');
export const countByActor = notImplementedStub('auditLog.repository', 'countByActor');
export const retentionPurge = notImplementedStub('auditLog.repository', 'retentionPurge');

export default {
  insert, insertMany, list, findById, listByModule,
  countByAction, countByActor, retentionPurge,
  _meta: { appendOnly: true, retentionDriven: true },
};
