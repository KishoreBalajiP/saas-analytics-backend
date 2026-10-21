/**
 * Tenant data catalogue (roadmap 2.9 - backups and recovery).
 *
 * WHY IT EXISTS
 *   A tenant export must contain EVERYTHING a workspace owns and NOTHING
 *   that belongs to another tenant or to the platform. This module is the
 *   single, explicit classification of every Mongoose model:
 *
 *     - `EXPORTED` entries say how the tenant's documents are selected
 *       (`scope`), which fields are redacted, how ids are remapped on import
 *       and which values a clone rewrites to stay unique.
 *     - `EXCLUDED` entries say why a collection is left out (credentials,
 *       tokens, platform-scoped or ephemeral records).
 *
 *   `tests/backups/tenant-data-catalogue.test.js` fails when a model is
 *   registered but classified in neither list, so a new collection cannot
 *   silently drop out of exports (or leak into them).
 *
 * ENTRY FIELDS (exported)
 *   model         Mongoose model name.
 *   scope         'self'   - the Tenant document itself (`_id` = tenant id)
 *                 'tenant' - documents whose `tenantId` equals the tenant id
 *                 'roles'  - RolePermission rows of the tenant's roles
 *   idReferenced  true when other documents may point at this document's
 *                 `_id`: the import maps the id (old -> new) and the content
 *                 digest includes it. false for high-volume, never-referenced
 *                 rows (dataset rows, audit/access trails): they get fresh
 *                 ids on import and their digest covers the content only.
 *   remap         'deep' - every ObjectId and every 24-hex token inside a
 *                 string is remapped when it names an exported document;
 *                 or an array of top-level fields remapped the same way
 *                 (dataset rows: never touch the customer's `data`).
 *   redact        fields replaced on export (secrets never leave the
 *                 platform); `redactions` documents them in the manifest.
 *   cloneRewrites values a clone (id-remapping import) overwrites to keep
 *                 globally unique keys unique and the clone inert.
 *
 * DESIGN CONSTRAINTS
 *   - Reads go through the raw driver collection, so soft-deleted rows are
 *     included and no Mongoose middleware rewrites the documents.
 *   - The order of `EXPORTED` matters: 'roles' scope needs the Role ids
 *     collected while exporting Role, dataset CSVs need the connector list.
 */

import mongoose from 'mongoose';

// Import every exported model so `mongoose.model(name)` resolves.
import '../models/Tenant.js';
import '../models/Role.js';
import '../models/RolePermission.js';
import '../models/User.js';
import '../models/UserRole.js';
import '../models/Setting.js';
import '../models/Subscription.js';
import '../models/SubscriptionHistory.js';
import '../models/PaymentTransaction.js';
import '../models/EntitlementOverride.js';
import '../models/UsageCounter.js';
import '../models/UsageReservation.js';
import '../models/Connector.js';
import '../models/SyncRun.js';
import '../models/ConnectorRow.js';
import '../models/Dashboard.js';
import '../models/Widget.js';
import '../models/Report.js';
import '../models/AlertRule.js';
import '../models/AlertEvent.js';
import '../models/AnalyticsQuery.js';
import '../models/Notification.js';
import '../models/AuditLog.js';
import '../models/AccessLog.js';
import '../models/Permission.js';

/** Replace a field with null when present. */
function nullField(doc, field) {
  if (Object.prototype.hasOwnProperty.call(doc, field)) doc[field] = null;
}

/**
 * Tenant-owned collections, in export (and import) order.
 * @type {ReadonlyArray<Object>}
 */
export const EXPORTED = Object.freeze([
  {
    model: 'Tenant',
    scope: 'self',
    idReferenced: true,
    remap: 'deep',
    cloneRewrites: (doc, ctx) => [
      { field: 'slug', value: `${String(doc.slug ?? 'tenant').slice(0, 40)}-restore-${ctx.suffix}` },
      { field: 'status', value: 'disabled' },
      { field: 'disabledAt', value: ctx.now },
      { field: 'disabledReason', value: `Restored from tenant export ${ctx.exportId}` },
    ],
  },
  { model: 'Role', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'RolePermission', scope: 'roles', idReferenced: true, remap: 'deep' },
  {
    model: 'User',
    scope: 'tenant',
    idReferenced: true,
    remap: 'deep',
    redactions: ['passwordHash (password hashes never leave the platform; users reset their password after a restore)'],
    redact: (doc) => nullField(doc, 'passwordHash'),
    // (ssoProvider, ssoSubject) is globally unique and belongs to the
    // original account: a clone's users are not linked to the identity provider.
    cloneRewrites: (doc) => (typeof doc.ssoSubject === 'string' ? [{ field: 'ssoSubject', value: null }] : []),
  },
  { model: 'UserRole', scope: 'tenant', idReferenced: true, remap: 'deep' },
  {
    model: 'Setting',
    scope: 'tenant',
    idReferenced: true,
    remap: 'deep',
    redactions: ['value when isSecret is true'],
    redact: (doc) => {
      if (doc.isSecret === true) nullField(doc, 'value');
    },
  },
  { model: 'Subscription', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'SubscriptionHistory', scope: 'tenant', idReferenced: true, remap: 'deep' },
  {
    model: 'PaymentTransaction',
    scope: 'tenant',
    idReferenced: true,
    remap: 'deep',
    // The provider order id is globally unique and belongs to the real
    // payment; a clone gets a marked copy so reconciliation never matches it.
    cloneRewrites: (doc, ctx) => [
      { field: 'providerOrderId', value: `${doc.providerOrderId}:restore:${ctx.suffix}` },
    ],
  },
  { model: 'EntitlementOverride', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'UsageCounter', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'UsageReservation', scope: 'tenant', idReferenced: true, remap: 'deep' },
  {
    model: 'Connector',
    scope: 'tenant',
    idReferenced: true,
    remap: 'deep',
    redactions: [
      'config (encrypted credentials; reconfigure connectors after a restore)',
      'webhookToken (inbound webhook capability URL; a new one is issued on reconfiguration)',
    ],
    redact: (doc) => {
      nullField(doc, 'config');
      delete doc.webhookToken;
    },
  },
  { model: 'SyncRun', scope: 'tenant', idReferenced: true, remap: 'deep' },
  {
    model: 'ConnectorRow',
    scope: 'tenant',
    idReferenced: false,
    remap: ['tenantId', 'connectorId'],
    datasetRows: true,
  },
  { model: 'Dashboard', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'Widget', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'Report', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'AlertRule', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'AlertEvent', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'AnalyticsQuery', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'Notification', scope: 'tenant', idReferenced: true, remap: 'deep' },
  { model: 'AuditLog', scope: 'tenant', idReferenced: false, remap: 'deep' },
  { model: 'AccessLog', scope: 'tenant', idReferenced: false, remap: 'deep' },
]);

/**
 * Collections deliberately left out of tenant exports, with the reason
 * recorded in every manifest.
 * @type {ReadonlyArray<{ model: string, reason: string }>}
 */
export const EXCLUDED = Object.freeze([
  { model: 'Session', reason: 'credential: refresh sessions are never exported' },
  { model: 'EmailVerificationToken', reason: 'credential: one-time verification tokens' },
  { model: 'PasswordResetToken', reason: 'credential: one-time password reset tokens' },
  { model: 'TenantInvitation', reason: 'credential: invitation token hashes; pending invitations are re-sent after a restore' },
  { model: 'ApiKey', reason: 'credential: API key secret hashes; keys are re-issued after a restore' },
  { model: 'EmbedToken', reason: 'credential: embed token hashes; embed links are re-issued after a restore' },
  { model: 'LoginAttempt', reason: 'ephemeral security counters (lockout), short retention' },
  { model: 'AuditExport', reason: 'platform support export bookkeeping; artefacts expire' },
  { model: 'TenantExport', reason: 'export bookkeeping (an archive cannot contain its own record)' },
  { model: 'WebhookEvent', reason: 'platform payment-provider inbox; billing state is exported via Subscription and PaymentTransaction' },
  { model: 'AccessRequest', reason: 'platform onboarding pipeline, recorded before the workspace exists' },
  { model: 'Admin', reason: 'platform-scoped: platform administrators' },
  { model: 'AdminRole', reason: 'platform-scoped: platform administrator grants' },
  { model: 'Module', reason: 'platform-scoped: permission module catalogue' },
  { model: 'Permission', reason: 'platform-scoped: permission catalogue (referenced keys are listed in reference/permissions.jsonl)' },
  { model: 'FeatureFlag', reason: 'platform-scoped: feature flag definitions and rollouts' },
  { model: 'MasterData', reason: 'platform-scoped: shared reference data' },
  { model: 'ComplianceLog', reason: 'platform-scoped: compliance case records kept by the platform' },
  { model: 'JobLock', reason: 'platform-scoped: scheduler locks (ephemeral)' },
  { model: 'JobRun', reason: 'platform-scoped: scheduled job executions span every tenant and carry no tenant id' },
]);

const EXPORTED_BY_MODEL = new Map(EXPORTED.map((entry) => [entry.model, entry]));
const EXCLUDED_BY_MODEL = new Map(EXCLUDED.map((entry) => [entry.model, entry]));

/** The exported entry for a model name, or undefined. */
export function exportedEntry(model) {
  return EXPORTED_BY_MODEL.get(model);
}

/** The excluded entry for a model name, or undefined. */
export function excludedEntry(model) {
  return EXCLUDED_BY_MODEL.get(model);
}

/** MongoDB collection name of a registered model (same on every connection). */
export function collectionNameOf(model) {
  return mongoose.model(model).collection.collectionName;
}

/** Archive member name of an exported collection. */
export function collectionFileOf(model) {
  return `collections/${collectionNameOf(model)}.jsonl`;
}

/**
 * Registered models that are classified in neither list (should be empty;
 * the catalogue test asserts it).
 *
 * @param {string[]} [modelNames=mongoose.modelNames()]
 * @returns {string[]}
 */
export function unclassifiedModels(modelNames = mongoose.modelNames()) {
  return modelNames.filter((name) => !EXPORTED_BY_MODEL.has(name) && !EXCLUDED_BY_MODEL.has(name)).sort();
}

/**
 * Selection filter for one exported entry.
 *
 * @param {Object} entry
 * @param {{ tenantId: string, roleIds: string[] }} ctx - roleIds as strings.
 * @returns {Object} raw driver filter.
 */
export function selectionFilter(entry, { tenantId, roleIds = [] }) {
  switch (entry.scope) {
    case 'self':
      return { _id: new mongoose.Types.ObjectId(String(tenantId)) };
    case 'roles':
      return { roleId: { $in: roleIds.map(String) } };
    case 'tenant':
      return { tenantId: String(tenantId) };
    default:
      throw new Error(`Unknown catalogue scope "${entry.scope}" for ${entry.model}`);
  }
}

/**
 * Apply an entry's export redactions to a copy of a raw document.
 *
 * @param {Object} entry
 * @param {Object} doc - raw driver document (not modified).
 * @returns {Object}
 */
export function redactDocument(entry, doc) {
  if (!entry.redact) return doc;
  const copy = { ...doc };
  entry.redact(copy);
  return copy;
}

export default {
  EXPORTED,
  EXCLUDED,
  exportedEntry,
  excludedEntry,
  collectionNameOf,
  collectionFileOf,
  unclassifiedModels,
  selectionFilter,
  redactDocument,
};
