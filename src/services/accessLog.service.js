/**
 * Access Log Service (architecture placeholder).
 *
 * PURPOSE
 *   Captures every authenticated HTTP request (high cardinality) and
 *   offers aggregations for ops dashboards.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - capture(req, res, { latencyMs })
 *   - list(filters), getTopPaths, getTopErrors
 *   - requestExport(filters) -> exportId
 *
 * CODING GUIDELINES
 *   - Writes are batched to keep the hot path low-overhead.
 *   - Authorization header MUST be redacted (`Bearer ***`).
 *   - Aggregations cache for 60s on TTL.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const capture = notImplementedStub('accessLog.service', 'capture');
export const list = notImplementedStub('accessLog.service', 'list');
export const getTopPaths = notImplementedStub('accessLog.service', 'getTopPaths');
export const getTopErrors = notImplementedStub('accessLog.service', 'getTopErrors');
export const requestExport = notImplementedStub('accessLog.service', 'requestExport');

export default {
  capture, list, getTopPaths, getTopErrors, requestExport,
  _meta: { batchedWrites: true },
};
