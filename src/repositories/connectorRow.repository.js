/**
 * ConnectorRow Repository (Sprint 4 - implemented).
 *
 * PURPOSE
 *   Data-access surface for ingested connector rows (`models/ConnectorRow.js`).
 *
 * RESPONSIBILITY
 *   - list / count / delete for a connector
 *   - upsertRows - idempotent bulk upsert keyed on `sourceRowId`
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - `upsertRows` uses the `{ connectorId, sourceRowId }` unique index so
 *     replaying a sync job is a no-op, never a duplicate.
 */

import mongoose from 'mongoose';
import { ConnectorRow } from '../models/ConnectorRow.js';

const { ObjectId } = mongoose.Types;

/** Paginated rows for a connector (tenant-scoped). */
export const list = async ({ connectorId, tenantId, page = 1, limit = 50 } = {}) => {
  const result = await ConnectorRow.paginate(
    { connectorId: new ObjectId(connectorId), tenantId },
    { page, limit, lean: true, sort: { ingestedAt: -1 } },
  );
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Count rows ingested for a connector. */
export const count = (connectorId, tenantId) =>
  ConnectorRow.countDocuments({ connectorId: new ObjectId(connectorId), tenantId });

/**
 * Bulk upsert rows keyed on `sourceRowId`. Idempotent: re-ingesting the same
 * rows does not create duplicates (the unique index enforces it).
 *
 * @param {string|ObjectId} connectorId
 * @param {string} tenantId
 * @param {Array<{ sourceRowId: string, data: object }>} rows
 * @returns {Promise<{ upserted: number, matched: number }>}
 */
export const upsertRows = async (connectorId, tenantId, rows) => {
  if (!rows || rows.length === 0) return { upserted: 0, matched: 0 };
  const cid = new ObjectId(connectorId);
  const ops = rows.map((row) => ({
    updateOne: {
      filter: { connectorId: cid, tenantId, sourceRowId: row.sourceRowId },
      // `data` lives in `$set` only: MongoDB rejects writing the same path
      // from both `$set` and `$setOnInsert`, and `data` is refreshed on
      // every match anyway.
      update: {
        $set: { data: row.data, ingestedAt: new Date() },
        $setOnInsert: { tenantId },
      },
      upsert: true,
    },
  }));
  const res = await ConnectorRow.bulkWrite(ops, { ordered: false });
  return { upserted: res.upsertedCount, matched: res.matchedCount };
};

/** Delete all rows for a connector (used on hard connector removal). */
export const deleteForConnector = (connectorId, tenantId) =>
  ConnectorRow.deleteMany({ connectorId: new ObjectId(connectorId), tenantId });

export default {
  list,
  count,
  upsertRows,
  deleteForConnector,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
