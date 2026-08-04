/**
 * Access Log Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable, high-volume data-access surface for per-request HTTP traces.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - insert(event), insertMany(events)   (batched)
 *   - list(filters), aggregateTopPaths(range),
 *     aggregateTopErrors(range)
 *   - retentionPurge({ before })
 *
 * CODING GUIDELINES
 *   - Inserts MUST be batched. The service buffers writes and flushes
 *     every N events / T milliseconds.
 *   - No lean requirement for inserts; reads return lean.
 *   - Aggregations live in MongoDB (Phase 2). Cold-storage routing in
 *     Phase 3+ via `src/storage/`.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const insert = notImplementedStub('accessLog.repository', 'insert');
export const insertMany = notImplementedStub('accessLog.repository', 'insertMany');
export const list = notImplementedStub('accessLog.repository', 'list');
export const aggregateTopPaths = notImplementedStub('accessLog.repository', 'aggregateTopPaths');
export const aggregateTopErrors = notImplementedStub('accessLog.repository', 'aggregateTopErrors');
export const retentionPurge = notImplementedStub('accessLog.repository', 'retentionPurge');

export default {
  insert, insertMany, list,
  aggregateTopPaths, aggregateTopErrors, retentionPurge,
  _meta: { batchedWrites: true },
};
