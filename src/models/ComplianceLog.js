/**
 * ComplianceLog (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Data-subject request lifecycle. Holds the state machine
 *   `received -> in_progress -> completed | rejected`. Even a "no data
 *   found" outcome produces a row (proof of search).
 *
 * PLANNED FIELDS
 *   _id, requestId (public reference, unique),
 *   type: 'export' | 'delete' | 'restrict' | 'consent.withdraw' | ...,
 *   subjectId, subjectType: 'user' | 'tenant',
 *   requesterId,                            // admin or the subject
 *   tenantScope?: string[],                 // empty for cross-tenant
 *   status: 'received' | 'in_progress' | 'completed' | 'rejected',
 *   evidenceKey?: string,                   // presigned storage URL
 *   dueBy, completedAt?,
 *   rejectionReason?,
 *   createdAt
 *
 * PLANNED INDEXES
 *   - unique(requestId)
 *   - { subjectId: 1, type: 1, createdAt: -1 }
 *   - { status: 1, dueBy: 1 }
 */

export const MODEL_NAME = 'ComplianceLog';

export default Object.freeze({
  name: MODEL_NAME,
  proofOfSearchRows: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/governance/compliance/README.md'],
});
