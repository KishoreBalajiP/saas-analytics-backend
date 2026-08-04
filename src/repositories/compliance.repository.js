/**
 * Compliance Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for data-subject compliance requests and
 *   their state transitions.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - file({ type, subjectId, requesterId, tenantScope })
 *   - list(filters), findById, findBySubject(subjectId)
 *   - transition(requestId, fromState, toState, { reason })
 *   - attachEvidence(requestId, key)   # storage URL
 *
 * CODING GUIDELINES
 *   - State machine transitions are validated here.
 *   - Rejections still produce a row (proof of search).
 *   - `tenantScope` may be empty for cross-tenant compliance flows.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const file = notImplementedStub('compliance.repository', 'file');
export const list = notImplementedStub('compliance.repository', 'list');
export const findById = notImplementedStub('compliance.repository', 'findById');
export const findBySubject = notImplementedStub('compliance.repository', 'findBySubject');
export const transition = notImplementedStub('compliance.repository', 'transition');
export const attachEvidence = notImplementedStub('compliance.repository', 'attachEvidence');

export default {
  file, list, findById, findBySubject,
  transition, attachEvidence,
  _meta: { proofOfSearchRows: true },
};
