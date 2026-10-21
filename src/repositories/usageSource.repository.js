/**
 * Usage source repository (roadmap 1.3 - quotas count resources).
 *
 * PURPOSE
 *   Read-only counts over the collections that the `current` usage
 *   counters mirror. Reconciliation compares these real counts with the
 *   stored counters; the stored-rows meter uses the row lookup to tell new
 *   rows from rows that a sync only refreshes.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - countResources(tenantId)          live connectors, dashboards, reports,
 *                                       scheduled reports, alerts, seats and
 *                                       stored rows for one tenant
 *   - findExistingSourceRowIds({ tenantId, connectorId, sourceRowIds })
 *   - listTenantIds({ afterId, limit }) paged tenant ids for the sweep
 *
 * CODING GUIDELINES
 *   - Every query filters by `tenantId` explicitly.
 *   - Soft-deleted documents are excluded by the softDelete plugin's
 *     automatic `deletedAt: null` filter (count/find); aggregates add it
 *     explicitly.
 *   - Seats: a user who is a member (any status except `invited`), plus an
 *     invited user who still holds a pending invitation. A revoked or
 *     expired-and-purged invitation does not hold a seat.
 *   - Stored rows: rows of live connectors only, matching what connector
 *     deletion releases.
 */

import mongoose from 'mongoose';
import { Connector } from '../models/Connector.js';
import { ConnectorRow } from '../models/ConnectorRow.js';
import { Dashboard } from '../models/Dashboard.js';
import { Report } from '../models/Report.js';
import { AlertRule } from '../models/AlertRule.js';
import { User } from '../models/User.js';
import { TenantInvitation } from '../models/TenantInvitation.js';
import { Tenant } from '../models/Tenant.js';

const { ObjectId } = mongoose.Types;

function tid(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  return String(tenantId);
}

/** Seats held in a tenant (members plus invitees with a pending invitation). */
export const countSeats = async (tenantId) => {
  const id = tid(tenantId);
  const [members, invited] = await Promise.all([
    User.countDocuments({ tenantId: id, status: { $ne: 'invited' } }),
    User.find({ tenantId: id, status: 'invited' }).select({ email: 1 }).lean(),
  ]);
  if (invited.length === 0) return members;
  const pending = await TenantInvitation.distinct('invitedEmail', {
    tenantId: id,
    status: 'pending',
    invitedEmail: { $in: invited.map((u) => u.email) },
  });
  return members + pending.length;
};

/** Rows stored for the tenant's live (non-deleted) connectors. */
export const countStoredRows = async (tenantId) => {
  const id = tid(tenantId);
  const connectors = await Connector.find({ tenantId: id }).select({ _id: 1 }).lean();
  if (connectors.length === 0) return 0;
  return ConnectorRow.countDocuments({
    tenantId: id,
    connectorId: { $in: connectors.map((c) => c._id) },
  });
};

/**
 * Real resource counts for every reconciled `current` metric.
 *
 * @param {string} tenantId
 * @returns {Promise<Record<string, number>>}
 */
export const countResources = async (tenantId) => {
  const id = tid(tenantId);
  const [connectors, dashboards, reports, scheduledReports, alerts, members, storedRows] = await Promise.all([
    Connector.countDocuments({ tenantId: id }),
    Dashboard.countDocuments({ tenantId: id }),
    Report.countDocuments({ tenantId: id }),
    Report.countDocuments({ tenantId: id, 'schedule.enabled': true }),
    AlertRule.countDocuments({ tenantId: id }),
    countSeats(id),
    countStoredRows(id),
  ]);
  return { members, connectors, dashboards, reports, scheduledReports, alerts, storedRows };
};

/**
 * Which of `sourceRowIds` already exist for the connector (a sync that
 * re-sends them refreshes rows instead of adding new ones).
 *
 * @returns {Promise<Set<string>>}
 */
export const findExistingSourceRowIds = async ({ tenantId, connectorId, sourceRowIds } = {}) => {
  const id = tid(tenantId);
  if (!connectorId) throw new Error('connectorId is required');
  if (!Array.isArray(sourceRowIds) || sourceRowIds.length === 0) return new Set();
  const found = await ConnectorRow.distinct('sourceRowId', {
    tenantId: id,
    connectorId: new ObjectId(String(connectorId)),
    sourceRowId: { $in: sourceRowIds },
    deletedAt: null,
  });
  return new Set(found);
};

/** Page through tenant ids in `_id` order (for the reconciliation sweep). */
export const listTenantIds = async ({ afterId = null, limit = 100 } = {}) => {
  const filter = afterId ? { _id: { $gt: new ObjectId(String(afterId)) } } : {};
  const docs = await Tenant.find(filter).sort({ _id: 1 }).limit(limit).select({ _id: 1 }).lean();
  return docs.map((d) => String(d._id));
};

export default {
  countSeats,
  countStoredRows,
  countResources,
  findExistingSourceRowIds,
  listTenantIds,
  _meta: { leanReturns: true, tenancy: 'tenant', readOnly: true },
};
