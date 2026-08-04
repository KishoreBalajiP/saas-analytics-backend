/**
 * Report (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Scheduled or one-shot analytics deliverable. Produces a frozen
 *   artefact in `src/storage/` and delivers via email or download.
 *
 * PLANNED FIELDS
 *   _id, tenantId, ownerId,
 *   name, description?,
 *   parameters: json,                       // user-supplied query inputs
 *   schedule?: {
 *     cron,                                 // node-cron compatible
 *     timezone,
 *     channel: 'email' | 'webhook',
 *     recipients: Array<{ type: 'user'|'external', value: string }>,
 *   },
 *   resultKey?: string,                     // latest artefact (storage)
 *   resultStatus: 'pending' | 'running' | 'ready' | 'failed',
 *   lastRunAt?, lastDurationMs?, lastError?,
 *   nextRunAt?,                             // scheduler projection
 *   createdAt, updatedAt
 *
 * PLANNED INDEXES
 *   - { tenantId: 1, ownerId: 1 }
 *   - { 'schedule.cron': 1 }                // scheduler lookup
 *
 * STORAGE
 *   - Result artefacts live in `src/storage/`. NEVER inline blobs in
 *     MongoDB. The `resultKey` carries the storage object key.
 */

export const MODEL_NAME = 'Report';
export const RESULT_STATUSES = Object.freeze([
  'pending', 'running', 'ready', 'failed',
]);

export default Object.freeze({
  name: MODEL_NAME,
  resultStatuses: RESULT_STATUSES,
  scheduled: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/analytics/reports/README.md'],
});
