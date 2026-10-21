/**
 * Support Diagnostics Service (roadmap 2.3 - sanitised diagnostics first).
 *
 * PURPOSE
 *   The first tool a support admin reaches for: operational facts about one
 *   workspace, so most tickets can be answered WITHOUT opening a support
 *   session as a customer.
 *
 * WHAT IT RETURNS (and nothing else)
 *   - tenant lifecycle: status, plan id, onboarding, time zone, timestamps
 *   - plan, subscription state and usage against limits
 *   - user counts per status and the number of live sessions
 *   - connector states (type, name, status, sync status, error count and
 *     the last error with credentials and email addresses masked)
 *   - recent sync runs (counts, timings, sanitised error codes)
 *   - request status counts and the most frequent failing paths (no query
 *     strings) over the last 24 hours
 *   - widgets/reports/alerts marked broken by a deleted dependency
 *   - the workspace's support access state (usable grant, pending
 *     break-glass requests, open support sessions)
 *
 * WHAT IT NEVER RETURNS
 *   Customer data rows, connector configs/credentials/field mappings, user
 *   emails or names, billing contacts, IPs, user agents, file names, API
 *   key or embed material. Every repository read uses an explicit field
 *   allow-list (`supportDiagnostics.repository.js`) and every free-text
 *   error passes through `scrubText`.
 *
 * SECURITY
 *   - The admin is re-read from the database; a tenant-scoped admin only
 *     reads its own tenant (403 otherwise).
 *   - Every read is recorded on the workspace's audit trail
 *     (`support.diagnostics` / `diagnostics.viewed`).
 */

import logger from '../utils/logger.js';
import { redactSecrets } from '../utils/sanitizeError.js';
import supportDiagnosticsRepository from '../repositories/supportDiagnostics.repository.js';
import * as entitlementService from './entitlement.service.js';
import * as supportAccessService from './supportAccess.service.js';
import { emit as emitAudit } from './auditLog.service.js';
import { SUPPORT_AUDIT_MODULES } from '../constants/support.js';

const WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_TEXT = 300;

/**
 * Mask credentials (via `redactSecrets`) and email addresses in free text,
 * keep the first line, and cap the length.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function scrubText(value) {
  if (value === undefined || value === null || value === '') return null;
  const firstLine = String(value).split('\n')[0].trim();
  if (!firstLine) return null;
  return redactSecrets(firstLine).replace(EMAIL_RE, '[email]').slice(0, MAX_TEXT);
}

/** A request path without its query string. */
function stripQuery(path) {
  const value = String(path ?? '');
  const cut = value.indexOf('?');
  return cut === -1 ? value : value.slice(0, cut);
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tenantFacts(tenant) {
  return {
    id: String(tenant._id),
    name: tenant.name ?? null,
    slug: tenant.slug ?? null,
    status: tenant.status ?? null,
    planId: tenant.planId ?? null,
    onboardingStatus: tenant.onboardingStatus ?? null,
    defaultTimezone: tenant.defaultTimezone ?? null,
    createdAt: iso(tenant.createdAt),
    trialEndsAt: iso(tenant.trialEndsAt),
    suspendedAt: iso(tenant.suspendedAt),
    disabledAt: iso(tenant.disabledAt),
    archivedAt: iso(tenant.archivedAt),
  };
}

function connectorFacts(connector) {
  return {
    id: String(connector._id),
    type: connector.type ?? null,
    name: connector.name ? String(connector.name).slice(0, 120) : null,
    status: connector.status ?? null,
    syncStatus: connector.syncStatus ?? null,
    lastSyncedAt: iso(connector.lastSyncedAt),
    syncRequestedAt: iso(connector.syncRequestedAt),
    errorCount: Number(connector.errorCount ?? 0),
    lastError: scrubText(connector.lastError),
    dataVersion: Number(connector.dataVersion ?? 0),
    updatedAt: iso(connector.updatedAt),
  };
}

function syncRunFacts(run) {
  const rows = run.rows && typeof run.rows === 'object' ? run.rows : {};
  const numericRows = Object.fromEntries(
    Object.entries(rows).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
  );
  return {
    id: String(run._id),
    connectorId: run.connectorId ? String(run.connectorId) : null,
    trigger: run.trigger ?? null,
    jobType: run.jobType ?? null,
    status: run.status ?? null,
    attempts: Number(run.attempts ?? 0),
    maxAttempts: Number(run.maxAttempts ?? 0),
    queuedAt: iso(run.queuedAt),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    rows: numericRows,
    error: run.error ? { code: run.error.code ?? null, message: scrubText(run.error.message) } : null,
  };
}

function grantFacts(grant) {
  if (!grant) return null;
  return {
    id: grant.id,
    kind: grant.kind,
    breakGlass: grant.breakGlass === true,
    status: grant.status,
    startsAt: grant.startsAt ?? null,
    expiresAt: grant.expiresAt ?? null,
  };
}

/** Usage against limits; a billing misconfiguration must not hide the rest. */
async function usageFacts(tenantId) {
  try {
    const usage = await entitlementService.getUsage(tenantId);
    return {
      plan: usage.plan ?? null,
      state: usage.state ?? null,
      writeBlocked: usage.writeBlocked === true,
      warnings: usage.warnings ?? [],
      metrics: usage.usage ?? {},
      error: null,
    };
  } catch (err) {
    logger.warn({ err: { message: err?.message }, tenantId }, 'support diagnostics: usage unavailable');
    return { plan: null, state: null, writeBlocked: false, warnings: [], metrics: {}, error: 'USAGE_UNAVAILABLE' };
  }
}

/**
 * Sanitised operational diagnostics for one workspace.
 *
 * @param {Object} params
 * @param {{ id: string }} params.actor - the authenticated admin (`req.admin`).
 * @param {string} params.tenantId
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @param {string} [params.requestId]
 * @param {Date} [params.now]
 */
export async function getTenantDiagnostics({ actor, tenantId, ip, userAgent, requestId, now = new Date() }) {
  const adminDoc = await supportAccessService.resolveAdmin(actor);
  const tenant = await supportAccessService.resolveTenantInScope(adminDoc, tenantId);
  const id = String(tenant._id);
  const since = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS);

  const [
    usersByStatus,
    activeSessions,
    connectors,
    connectorsByStatus,
    syncRuns,
    failedSyncRuns,
    statusCounts,
    errorPaths,
    broken,
    usage,
    supportAccess,
  ] = await Promise.all([
    supportDiagnosticsRepository.countUsersByStatus(id),
    supportDiagnosticsRepository.countActiveSessions(id, now),
    supportDiagnosticsRepository.listConnectorStates(id),
    supportDiagnosticsRepository.countConnectorsByStatus(id),
    supportDiagnosticsRepository.listRecentSyncRuns(id),
    supportDiagnosticsRepository.countFailedSyncRuns(id, since),
    supportDiagnosticsRepository.requestStatusCounts(id, since),
    supportDiagnosticsRepository.topErrorPaths(id, since),
    supportDiagnosticsRepository.countBroken(id),
    usageFacts(id),
    supportAccessService.supportAccessSummary(id),
  ]);

  const totalRequests = statusCounts.reduce((sum, row) => sum + row.count, 0);
  const clientErrors = statusCounts.filter((r) => r.statusCode >= 400 && r.statusCode < 500).reduce((s, r) => s + r.count, 0);
  const serverErrors = statusCounts.filter((r) => r.statusCode >= 500).reduce((s, r) => s + r.count, 0);

  const diagnostics = {
    generatedAt: now.toISOString(),
    window: { hours: WINDOW_HOURS, since: since.toISOString() },
    tenant: tenantFacts(tenant),
    subscription: {
      plan: usage.plan,
      state: usage.state,
      writeBlocked: usage.writeBlocked,
      warnings: usage.warnings,
      error: usage.error,
    },
    usage: usage.metrics,
    users: {
      total: Object.values(usersByStatus).reduce((sum, n) => sum + n, 0),
      byStatus: usersByStatus,
      activeSessions,
    },
    connectors: {
      total: Object.values(connectorsByStatus).reduce((sum, n) => sum + n, 0),
      byStatus: connectorsByStatus,
      withErrors: connectors.filter((c) => Number(c.errorCount ?? 0) > 0 || c.status === 'error').length,
      items: connectors.map(connectorFacts),
    },
    syncRuns: {
      failedInWindow: failedSyncRuns,
      recent: syncRuns.map(syncRunFacts),
    },
    requests: {
      total: totalRequests,
      clientErrors,
      serverErrors,
      errorRate: totalRequests > 0 ? Number(((clientErrors + serverErrors) / totalRequests).toFixed(4)) : 0,
      byStatus: statusCounts,
      topErrors: errorPaths.map((row) => ({
        path: stripQuery(row._id?.path),
        statusCode: Number(row._id?.statusCode ?? 0),
        count: row.count,
      })),
    },
    broken,
    supportAccess: {
      active: grantFacts(supportAccess.active),
      pendingBreakGlass: supportAccess.pendingBreakGlass.length,
      openSessions: supportAccess.openSessions,
    },
  };

  await emitAudit({
    actor: { type: 'admin', id: String(adminDoc._id), display: adminDoc.email ?? String(adminDoc._id) },
    action: 'diagnostics.viewed',
    module: SUPPORT_AUDIT_MODULES.DIAGNOSTICS,
    resource: { type: 'tenant', id },
    tenantId: id,
    ip,
    userAgent,
    requestId,
  });

  return diagnostics;
}

export default { getTenantDiagnostics, scrubText };
