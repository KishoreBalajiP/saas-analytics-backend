/**
 * Audit policy per model (roadmap 2.5; findings gov.02, gov.04, db.11).
 *
 * WHY IT EXISTS
 *   The audit plugin used to copy whole documents into the trail, so
 *   credential hashes, encrypted connector configs, webhook tokens and raw
 *   provider payloads ended up in an exportable log, and bookkeeping writes
 *   (every token refresh, every usage increment, every failed password)
 *   flooded it. This file is the single, reviewable answer to "what does the
 *   trail keep for model X":
 *
 *   - `fields`   ALLOW-LIST of (dotted) paths copied into `before` / `after`.
 *                Anything else is never stored; a change to it shows up only
 *                as a name in `metadata.changedFields` (e.g. `passwordHash`
 *                changed, without its value).
 *   - `ignore`   bookkeeping paths: a write that touches only these is not a
 *                business change and writes no row (and for query updates the
 *                plugin skips the extra read of the prior state).
 *   - `events`   optional subset of plugin events to record (default: all).
 *   - `mode: 'off'` the model writes no rows at all: high-volume operational
 *                data whose meaningful changes are audited elsewhere (usage
 *                counters, ingested connector rows, analytics query log,
 *                notifications, alert events).
 *   - `secretWhen` `{ flag, fields }`: when the snapshot's `flag` is true the
 *                listed fields are redacted (secret settings).
 *
 *   A credential-like key (`utils/auditPayload.isSensitiveKey`) is redacted
 *   even if someone allow-lists it by mistake.
 *
 * HOW TO EXTEND
 *   Applying `audit` to a new model REQUIRES an entry here (a test fails
 *   otherwise). List the business fields; never list hashes, tokens,
 *   secrets, encrypted blobs or raw third-party payloads.
 *
 *   Plugin events: create, update, softDelete, restore, delete (single hard
 *   delete), bulkUpdate (updateOne/updateMany/replaceOne without a document),
 *   bulkDelete (deleteMany), bulkCreate (insertMany).
 */

/** Paths that are never business data (handled by the consumer). */
export const META_PATHS = Object.freeze(['_id', '__v', 'createdAt', 'updatedAt']);

const OWNERSHIP = ['createdBy', 'updatedBy', 'deletedAt', 'deletedBy'];
const BROKEN = ['brokenAt', 'brokenReason', 'brokenRef'];

function policy(definition) {
  return Object.freeze({
    mode: definition.mode ?? 'on',
    fields: Object.freeze([...(definition.fields ?? [])]),
    ignore: Object.freeze([...(definition.ignore ?? [])]),
    events: definition.events ? Object.freeze([...definition.events]) : null,
    secretWhen: definition.secretWhen ?? null,
  });
}

const OFF = policy({ mode: 'off' });

export const AUDIT_POLICY = Object.freeze({
  AccessRequest: policy({
    fields: ['name', 'email', 'workspaceName', 'reason', 'status', 'reference', 'reviewedAt',
      'reviewedBy', 'decisionNote', 'tenantId', 'invitationId'],
  }),
  Admin: policy({
    fields: ['email', 'status', 'adminType', 'tenantScope', 'mfaEnabled', 'profile.name',
      'profile.locale', 'profile.timezone', 'lockedUntil', ...OWNERSHIP],
    ignore: ['failedAttempts', 'lastLoginAt'],
  }),
  AdminRole: policy({
    fields: ['adminId', 'tenantId', 'roleId', 'grantedBy', 'grantedAt', 'expiresAt', 'deletedAt', 'deletedBy'],
  }),
  AlertEvent: OFF,
  AlertRule: policy({
    fields: ['tenantId', 'name', 'description', 'enabled', 'source', 'dashboardId', 'widgetId', 'query',
      'metric', 'condition', 'threshold', 'thresholdHigh', 'schedule', 'cooldownMinutes',
      'notification.channels', 'notification.recipients', ...OWNERSHIP, ...BROKEN],
    ignore: ['lastEvaluatedAt', 'lastTriggeredAt', 'nextEvaluationAt', 'lockedBy', 'lockedUntil'],
  }),
  AnalyticsQuery: OFF,
  ApiKey: policy({
    fields: ['tenantId', 'name', 'prefix', 'scopes', 'expiresAt', 'status', 'revokedAt', 'revokedReason',
      'revokedBy', ...OWNERSHIP],
    ignore: ['lastUsedAt', 'lastUsedIp'], // devapi: lastUsedIp is bookkeeping
  }),
  Connector: policy({
    fields: ['tenantId', 'type', 'name', 'status', 'webhookSignatureVersion', 'webhookToleranceSeconds',
      'fieldMapping', ...OWNERSHIP],
    ignore: ['lastSyncedAt', 'syncStatus', 'syncRequestedAt', 'syncLeaseUntil', 'currentSyncRunId',
      'lastError', 'errorCount', 'dataVersion'],
  }),
  ConnectorRow: OFF,
  // rls: dataset grants and row-level security rules.
  DatasetAccess: policy({ fields: ['tenantId', 'connectorId', 'restricted', 'grants', 'updatedBy'] }),
  RowPolicy: policy({ fields: ['tenantId', 'connectorId', 'field', 'op', 'attribute', 'enabled', 'createdBy'] }),
  Dashboard: policy({
    fields: ['tenantId', 'name', 'description', 'status', 'layout', 'filters', 'refresh', 'shares', ...OWNERSHIP],
  }),
  EmailVerificationToken: policy({
    fields: ['tenantId', 'userId', 'email', 'status', 'expiresAt', 'usedAt', 'deliveryStatus'],
    ignore: ['lastSentAt', 'deliveryError'],
  }),
  EmbedToken: policy({
    fields: ['tenantId', 'dashboardId', 'widgetId', 'name', 'status', 'expiresAt', 'revokedAt',
      'revokedReason', 'revokedBy', ...OWNERSHIP],
    ignore: ['lastUsedAt'],
  }),
  EntitlementOverride: policy({
    fields: ['tenantId', 'metric', 'kind', 'valueKind', 'value', 'reason', 'expiresAt', 'grantedBy',
      'revokedAt', 'revokedBy', 'revokeReason'],
  }),
  FeatureFlag: policy({
    fields: ['key', 'name', 'description', 'type', 'defaultValue', 'enabled', 'rollout', 'isReadonly',
      'updatedBy', 'deletedAt', 'deletedBy'],
  }),
  MasterData: policy({
    fields: ['catalogue', 'code', 'locale', 'name', 'data', 'isSystem', ...OWNERSHIP],
  }),
  Module: policy({
    fields: ['key', 'name', 'description', 'parentKey', 'isSystem', ...OWNERSHIP],
  }),
  Notification: OFF,
  PasswordResetToken: policy({
    fields: ['portal', 'actorId', 'tenantId', 'expiresAt', 'usedAt'],
  }),
  PaymentTransaction: policy({
    fields: ['tenantId', 'planId', 'amountMinor', 'currency', 'provider', 'providerOrderId',
      'providerPaymentId', 'receipt', 'status', 'failureReason', 'capturedAt', 'failedAt', 'refundedAt',
      'createdBy', 'updatedBy',
      // billing: prepaid term and capture application.
      'interval', 'termMonths', 'authorizedAt', 'expiredAt', 'appliedAt'],
    ignore: ['lastReconciledAt', 'reconcileAttempts',
      // billing: reconcile scheduling and the short apply claim.
      'nextReconcileAt', 'applyingUntil', 'applyError', 'clientVerifiedAt'],
  }),
  Permission: policy({
    fields: ['moduleId', 'module', 'action', 'key', 'description', 'isSystem', ...OWNERSHIP],
  }),
  Report: policy({
    fields: ['tenantId', 'ownerId', 'name', 'description', 'status', 'source', 'dashboardId', 'widgetId',
      'query', 'format', 'filters', 'schedule', ...OWNERSHIP, ...BROKEN],
    ignore: ['runs', 'lastRun', 'nextRunAt', 'lockedBy', 'lockedUntil', 'lastScheduledAt'],
  }),
  Role: policy({
    fields: ['tenantId', 'name', 'description', 'level', 'isSystem', ...OWNERSHIP],
  }),
  RolePermission: policy({
    fields: ['roleId', 'permissionId', 'grantedBy', 'grantedAt', 'deletedAt', 'deletedBy'],
  }),
  // Sessions churn on every login and refresh; logins, revocations and
  // replays are explicit security events. Only bulk revocations and hard
  // deletes are kept as model rows.
  Session: policy({
    events: ['bulkUpdate', 'bulkDelete', 'delete'],
    fields: ['sessionId', 'actorId', 'actorType', 'tenantId', 'impersonatedBy', 'status', 'issuedAt',
      'expiresAt', 'revokedAt', 'revokedReason'],
    ignore: ['lastUsedAt'],
  }),
  Setting: policy({
    fields: ['key', 'scope', 'tenantId', 'group', 'type', 'value', 'description', 'isSecret', 'isReadonly',
      'version', 'updatedBy', 'deletedAt', 'deletedBy'],
    secretWhen: { flag: 'isSecret', fields: ['value'] },
  }),
  Subscription: policy({
    fields: ['tenantId', 'planId', 'state', 'trialEndsAt', 'currentPeriodStart', 'currentPeriodEnd',
      'graceEndsAt', 'canceledAt', 'cancelAtPeriodEnd', 'paymentProvider', 'paymentReference',
      'previousPlanId', 'previousState', 'stateChangedAt', 'createdBy', 'updatedBy',
      // billing: prepaid-term bookkeeping.
      'billingInterval', 'lastTransactionId', 'adminHold', 'scheduledChange'],
    ignore: ['lastReconciledAt'],
  }),
  SubscriptionHistory: policy({
    fields: ['tenantId', 'type', 'fromState', 'toState', 'fromPlanId', 'toPlanId', 'reason', 'actor',
      'occurredAt'],
  }),
  Tenant: policy({
    fields: ['name', 'slug', 'logoUrl', 'planId', 'status', 'billingEmail', 'country', 'defaultLocale',
      'defaultTimezone', 'defaultCurrency', 'trialEndsAt', 'ownerId', 'onboardingStatus', 'suspendedAt',
      'suspendedReason', 'disabledAt', 'disabledReason', 'archivedAt', 'archivedReason', ...OWNERSHIP],
  }),
  TenantInvitation: policy({
    fields: ['tenantId', 'invitedEmail', 'roleId', 'roleName', 'invitedBy', 'status', 'expiresAt',
      'acceptedAt', 'revokedAt', 'acceptedBy'],
  }),
  UsageCounter: OFF,
  User: policy({
    fields: ['tenantId', 'email', 'ssoProvider', 'status', 'profile.name', 'profile.locale',
      'profile.timezone', 'profile.avatarUrl', 'lockedUntil', 'invitedBy', 'acceptedAt', 'deletedAt',
      'deletedBy'],
    ignore: ['failedAttempts', 'lastLoginAt'],
  }),
  // ai-catalogue: metric definitions (definitions are not secret; values copied).
  MetricDefinition: policy({
    fields: ['tenantId', 'key', 'version', 'label', 'connectorId', 'aggregation', 'field', 'status',
      'approvedBy', 'approvedAt', 'archivedBy', 'archivedAt'],
  }),
  UserRole: policy({
    fields: ['tenantId', 'userId', 'roleId', 'scope', 'grantedBy', 'grantedAt', 'expiresAt', 'deletedAt',
      'deletedBy'],
  }),
  WebhookEvent: policy({
    fields: ['provider', 'eventId', 'eventType', 'processed', 'error', 'processedAt', 'tenantId',
      'subscriptionId',
      // billing: processing state of the stored event.
      'status', 'outcome'],
    // billing: retry bookkeeping is not a business change.
    ignore: ['attempts', 'nextAttemptAt', 'leaseUntil', 'deliveries'],
  }),
  Widget: policy({
    fields: ['tenantId', 'dashboardId', 'name', 'type', 'datasetId', 'query', 'visualization', 'position',
      ...OWNERSHIP, ...BROKEN],
  }),
});

/**
 * Policy for a model without an entry: record that something changed and
 * which fields, but copy no values. A test fails for audited models
 * without an explicit entry, so this only guards against surprises.
 */
export const DEFAULT_POLICY = policy({ fields: [] });

/** @returns {ReturnType<typeof policy>} */
export function getAuditPolicy(modelName) {
  return (modelName && AUDIT_POLICY[modelName]) || DEFAULT_POLICY;
}

/** Whether a plugin event for this model is recorded at all. */
export function recordsEvent(auditPolicy, eventName) {
  if (auditPolicy.mode === 'off') return false;
  return !auditPolicy.events || auditPolicy.events.includes(eventName);
}

/** True when `path` (dotted) is listed in, or nested under, one of `paths`. */
export function pathMatches(paths, path) {
  const value = String(path);
  return paths.some((p) => value === p || value.startsWith(`${p}.`));
}

/**
 * Field paths an update document touches (`{ $set: { a: 1 } }`,
 * `{ $inc: { 'b.c': 1 } }`, or a plain replacement `{ a: 1 }`).
 *
 * @param {Object|Array|null} update
 * @returns {string[]}
 */
export function updatedPaths(update) {
  if (!update || typeof update !== 'object') return [];
  // Aggregation-pipeline updates: inspect each `$set` / `$addFields` stage.
  if (Array.isArray(update)) return update.flatMap((stage) => updatedPaths(stage));
  const paths = [];
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith('$')) {
      if (value && typeof value === 'object' && !Array.isArray(value)) paths.push(...Object.keys(value));
    } else {
      paths.push(key);
    }
  }
  return paths;
}

/**
 * True when every path the update touches is bookkeeping (`ignore`) or meta
 * (`updatedAt`), i.e. the write is not a business change.
 */
export function touchesOnlyIgnored(auditPolicy, update) {
  const paths = updatedPaths(update);
  if (paths.length === 0) return false;
  return paths.every((p) => pathMatches(auditPolicy.ignore, p) || pathMatches(META_PATHS, p));
}

export default {
  AUDIT_POLICY,
  DEFAULT_POLICY,
  META_PATHS,
  getAuditPolicy,
  recordsEvent,
  pathMatches,
  updatedPaths,
  touchesOnlyIgnored,
};
