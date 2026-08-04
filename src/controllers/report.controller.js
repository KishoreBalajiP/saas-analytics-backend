/**
 * Report Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/reports`. Scheduled + ad-hoc analytics
 *   deliverables.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listReports, createReport, getReport, updateReport, runReport,
 *     deleteReport, downloadReport
 *
 * CODING GUIDELINES
 *   - Ad-hoc runs always enqueue; never run inline.
 *   - Result artefacts are presigned; never store binaries in MongoDB.
 *   - Per-recipient channel matrix applies on scheduled runs.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listReports = notImplemented('GET /reports');
export const createReport = notImplemented('POST /reports');
export const getReport = notImplemented('GET /reports/:id');
export const updateReport = notImplemented('PATCH /reports/:id');
export const runReport = notImplemented('POST /reports/:id/run');
export const deleteReport = notImplemented('DELETE /reports/:id');
export const downloadReport = notImplemented('GET /reports/:id/download');

export default {
  listReports, createReport, getReport, updateReport,
  runReport, deleteReport, downloadReport,
};
