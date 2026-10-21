/**
 * Synthetic event streams for the security detection tests (roadmap 2.6).
 *
 * Events are written with the native driver where the production writers
 * stamp their own timestamps (audit log, access log, exports, sync runs) so
 * every test controls time exactly, and security events can carry the
 * `metadata` field the roadmap 2.5 security event service writes.
 */

import { LoginAttempt } from '../../src/models/LoginAttempt.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { AccessLog } from '../../src/models/AccessLog.js';
import { AuditExport } from '../../src/models/AuditExport.js';
import { SyncRun } from '../../src/models/SyncRun.js';
import { SecurityAlert } from '../../src/models/SecurityAlert.js';
import { SecurityDetectionCursor } from '../../src/models/SecurityDetectionCursor.js';
import securitySignalRepository from '../../src/repositories/securitySignal.repository.js';
import { runDetection } from '../../src/services/securityDetection/engine.js';

/** Fixed reference instant every scenario is expressed against. */
export const T0 = new Date('2026-10-20T12:00:00.000Z');

/** T0 plus `minutes` (negative = before T0). */
export function at(minutes, seconds = 0) {
  return new Date(T0.getTime() + minutes * 60 * 1000 + seconds * 1000);
}

/** `now` for a run whose evaluation end (now - settle) is T0 + `minutes`. */
export function nowFor(minutes, { lagMinutes = 0 } = {}) {
  // Default SECURITY_DETECTION_SETTLE_SEC is 60.
  return at(minutes + 1 + lagMinutes);
}

export async function loginAttempts(rows) {
  await LoginAttempt.collection.insertMany(rows.map((row) => ({
    actorId: null,
    actorType: 'user',
    tenantId: null,
    ip: '203.0.113.7',
    userAgent: 'test',
    success: false,
    reason: 'invalid_credentials',
    ...row,
  })));
}

export async function auditEvents(rows) {
  await AuditLog.collection.insertMany(rows.map((row) => ({
    actorType: 'admin',
    actorId: null,
    actorDisplay: '',
    tenantId: null,
    resourceType: null,
    resourceId: null,
    result: 'success',
    reason: null,
    category: 'security',
    metadata: null,
    ...row,
  })));
}

export async function accessRows(rows) {
  await AccessLog.collection.insertMany(rows.map((row) => ({
    actorType: 'user',
    actorId: null,
    tenantId: null,
    method: 'GET',
    path: '/api/v1/dashboards',
    statusCode: 200,
    latencyMs: 10,
    ip: '198.51.100.4',
    event: 'request',
    ...row,
  })));
}

export async function auditExports(rows) {
  await AuditExport.collection.insertMany(rows.map((row, index) => ({
    exportId: `exp_${Date.now()}_${index}_${Math.random().toString(36).slice(2)}`,
    kind: 'audit',
    tenantId: null,
    format: 'csv',
    filters: {},
    status: 'completed',
    recordCount: 10,
    ...row,
    updatedAt: row.createdAt,
  })));
}

export async function failedSyncRuns(rows) {
  await SyncRun.collection.insertMany(rows.map((row) => ({
    trigger: 'manual',
    jobType: 'ingest',
    status: 'failed',
    attempts: 1,
    error: { code: 'CONNECTOR_SOURCE_UNAVAILABLE', message: 'The source could not be reached.' },
    ...row,
  })));
}

/** Per-minute request signals (`bucket` must be minute-aligned). */
export async function signals(rows) {
  await securitySignalRepository.upsertMany(rows.map((row) => ({
    clientErrors: 0,
    serverErrors: 0,
    ipRanges: [],
    actors: [],
    tenantId: null,
    ...row,
  })));
}

/** Run one rule through the real engine (notifications off unless asked). */
export function runRule(rule, now, { overrides = {}, notify = false, context } = {}) {
  return runDetection({
    rules: [rule],
    now,
    notify,
    settingOverrides: Object.keys(overrides).length ? { [rule.id]: overrides } : {},
    ...(context ? { context } : {}),
  });
}

export function alertsFor(ruleId) {
  return SecurityAlert.find({ ruleId }).sort({ createdAt: 1 }).lean();
}

export function cursorFor(ruleId) {
  return SecurityDetectionCursor.findById(ruleId).lean();
}
