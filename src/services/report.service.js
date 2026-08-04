/**
 * Report Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for scheduled + ad-hoc analytics reports. Owns the
 *   state machine from `pending -> running -> ready/failed`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listReports, createReport, getReport
 *   - updateReport, runReport, deleteReport
 *   - downloadReport (returns presigned URL)
 *
 * CODING GUIDELINES
 *   - Every run persists parameters with the artefact. Audits added too.
 *   - Result binaries NEVER live in MongoDB; always in `src/storage/`.
 *   - Schedule expressions are validated and stored verbatim
 *     (node-cron compatible).
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('report.service', 'list');
export const create = notImplementedStub('report.service', 'create');
export const getById = notImplementedStub('report.service', 'getById');
export const update = notImplementedStub('report.service', 'update');
export const run = notImplementedStub('report.service', 'run');
export const remove = notImplementedStub('report.service', 'remove');
export const download = notImplementedStub('report.service', 'download');

export default {
  list, create, getById, update, run, remove, download,
  _meta: { queue: 'analytics.jobs', storage: 'src/storage' },
};
