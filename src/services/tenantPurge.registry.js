/**
 * Tenant purge registry (roadmap 2.10, ten.14).
 *
 * PURPOSE
 *   The single list of every collection that can hold a tenant's data and
 *   what the purge does with it. `tenantDeletion.service.js#purgeTenant`
 *   walks it to delete, and walks it again to verify that nothing is left.
 *   `tests/members/tenant-purge-coverage.test.js` fails when a model gains a
 *   `tenantId` path (or a new model is added) without an entry here, so a
 *   new collection cannot silently escape the purge.
 *
 * MODES
 *   - delete  : every document matching `filter(ctx)` is removed (including
 *               soft-deleted ones: the purge works on the raw collection).
 *   - detach  : the tenant is removed from shared documents (`update`);
 *               verification counts documents still referencing it.
 *   - retain  : kept on purpose under the named policy (audit trail,
 *               compliance evidence, financial records); reported, not
 *               deleted. `when(config)` can turn a retain into a delete.
 *   - exempt  : platform records that hold no tenant content (listed so
 *               the coverage test knows they were considered).
 *
 * ORDER
 *   Entries run top to bottom. Grants and role permissions go before the
 *   roles they reference; the Tenant document goes last.
 *
 * CONTEXT
 *   `ctx = { tenantId, tenantObjectId, userIds, roleIds }`, collected before
 *   anything is deleted.
 */

import AccessLog from '../models/AccessLog.js';
import AccessRequest from '../models/AccessRequest.js';
import AdminRole from '../models/AdminRole.js';
import AlertEvent from '../models/AlertEvent.js';
import AlertRule from '../models/AlertRule.js';
import AnalyticsQuery from '../models/AnalyticsQuery.js';
import ApiKey from '../models/ApiKey.js';
import AuditExport from '../models/AuditExport.js';
import AuditLog from '../models/AuditLog.js';
import ComplianceLog from '../models/ComplianceLog.js';
import Connector from '../models/Connector.js';
import ConnectorRow from '../models/ConnectorRow.js';
import Dashboard from '../models/Dashboard.js';
import EmailVerificationToken from '../models/EmailVerificationToken.js';
import EmbedToken from '../models/EmbedToken.js';
import EntitlementOverride from '../models/EntitlementOverride.js';
import FeatureFlag from '../models/FeatureFlag.js';
import JobLock from '../models/JobLock.js';
import LoginAttempt from '../models/LoginAttempt.js';
import Notification from '../models/Notification.js';
import PasswordResetToken from '../models/PasswordResetToken.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Report from '../models/Report.js';
import Role from '../models/Role.js';
import RolePermission from '../models/RolePermission.js';
import Session from '../models/Session.js';
import Setting from '../models/Setting.js';
import Subscription from '../models/Subscription.js';
import SubscriptionHistory from '../models/SubscriptionHistory.js';
import SyncRun from '../models/SyncRun.js';
import Tenant from '../models/Tenant.js';
import TenantInvitation from '../models/TenantInvitation.js';
// backups: tenant data export bookkeeping (archives purged via STORAGE_PREFIXES).
import TenantExport from '../models/TenantExport.js';
import UsageCounter from '../models/UsageCounter.js';
import UsageReservation from '../models/UsageReservation.js';
import User from '../models/User.js';
import UserRole from '../models/UserRole.js';
import WebhookEvent from '../models/WebhookEvent.js';
import Widget from '../models/Widget.js';
// retention: queued email (recipients and encrypted variables) and the
// tenant storage prefixes are owned by the retention package.
import OutboundEmail from '../models/OutboundEmail.js';
// support, detection, rls: tenant-owned rows added by later packages.
import SupportAccessGrant from '../models/SupportAccessGrant.js';
import SupportImpersonation from '../models/SupportImpersonation.js';
import SecurityAlert from '../models/SecurityAlert.js';
import SecuritySignal from '../models/SecuritySignal.js';
import DatasetAccess from '../models/DatasetAccess.js';
import RowPolicy from '../models/RowPolicy.js';
// datasets: profiled schema per connector.
import DatasetSchema from '../models/DatasetSchema.js';
// ai, devapi, delivery, embedding, onboarding: tenant-owned rows.
import AiConsent from '../models/AiConsent.js';
import AiQuestion from '../models/AiQuestion.js';
import ApiKeyUsage from '../models/ApiKeyUsage.js';
import DeliveryDestination from '../models/DeliveryDestination.js';
import DeliveryRun from '../models/DeliveryRun.js';
import DeliveryUnsubscribe from '../models/DeliveryUnsubscribe.js';
import EmbedConfig from '../models/EmbedConfig.js';
import Insight from '../models/Insight.js';
import MetricDefinition from '../models/MetricDefinition.js';
import NotificationPreference from '../models/NotificationPreference.js';
import { tenantStoragePrefixes } from './retention.service.js';

const byTenant = (ctx) => ({ tenantId: ctx.tenantId });

/** @type {Array<{ name: string, model: import('mongoose').Model, mode: 'delete'|'detach'|'retain'|'exempt', filter?: Function, update?: Function, policy?: string, when?: Function, reason?: string }>} */
export const PURGE_REGISTRY = Object.freeze([
  // Access first: sessions and credentials, so nothing can act mid-purge.
  { name: 'Session', model: Session, mode: 'delete', filter: byTenant },
  { name: 'ApiKey', model: ApiKey, mode: 'delete', filter: byTenant },
  { name: 'EmbedToken', model: EmbedToken, mode: 'delete', filter: byTenant },
  { name: 'PasswordResetToken', model: PasswordResetToken, mode: 'delete', filter: byTenant },
  { name: 'EmailVerificationToken', model: EmailVerificationToken, mode: 'delete', filter: byTenant },
  { name: 'LoginAttempt', model: LoginAttempt, mode: 'delete', filter: byTenant },
  { name: 'TenantInvitation', model: TenantInvitation, mode: 'delete', filter: byTenant },
  { name: 'AccessRequest', model: AccessRequest, mode: 'delete', filter: byTenant },
  { name: 'AdminRole', model: AdminRole, mode: 'delete', filter: byTenant },

  // Data and content.
  { name: 'ConnectorRow', model: ConnectorRow, mode: 'delete', filter: byTenant },
  { name: 'SyncRun', model: SyncRun, mode: 'delete', filter: byTenant },
  { name: 'Connector', model: Connector, mode: 'delete', filter: byTenant },
  { name: 'Widget', model: Widget, mode: 'delete', filter: byTenant },
  { name: 'Dashboard', model: Dashboard, mode: 'delete', filter: byTenant },
  { name: 'Report', model: Report, mode: 'delete', filter: byTenant },
  { name: 'AlertEvent', model: AlertEvent, mode: 'delete', filter: byTenant },
  { name: 'AlertRule', model: AlertRule, mode: 'delete', filter: byTenant },
  { name: 'AnalyticsQuery', model: AnalyticsQuery, mode: 'delete', filter: byTenant },
  { name: 'Notification', model: Notification, mode: 'delete', filter: byTenant },
  { name: 'AuditExport', model: AuditExport, mode: 'delete', filter: byTenant },
  { name: 'TenantExport', model: TenantExport, mode: 'delete', filter: byTenant },
  { name: 'Setting', model: Setting, mode: 'delete', filter: byTenant },
  { name: 'OutboundEmail', model: OutboundEmail, mode: 'delete', filter: byTenant },
  { name: 'SupportAccessGrant', model: SupportAccessGrant, mode: 'delete', filter: byTenant },
  { name: 'SupportImpersonation', model: SupportImpersonation, mode: 'delete', filter: byTenant },
  { name: 'SecurityAlert', model: SecurityAlert, mode: 'delete', filter: byTenant },
  { name: 'SecuritySignal', model: SecuritySignal, mode: 'delete', filter: byTenant },
  { name: 'DatasetAccess', model: DatasetAccess, mode: 'delete', filter: byTenant },
  { name: 'RowPolicy', model: RowPolicy, mode: 'delete', filter: byTenant },
  { name: 'DatasetSchema', model: DatasetSchema, mode: 'delete', filter: byTenant },
  { name: 'AiConsent', model: AiConsent, mode: 'delete', filter: byTenant },
  { name: 'AiQuestion', model: AiQuestion, mode: 'delete', filter: byTenant },
  { name: 'ApiKeyUsage', model: ApiKeyUsage, mode: 'delete', filter: byTenant },
  { name: 'DeliveryDestination', model: DeliveryDestination, mode: 'delete', filter: byTenant },
  { name: 'DeliveryRun', model: DeliveryRun, mode: 'delete', filter: byTenant },
  { name: 'DeliveryUnsubscribe', model: DeliveryUnsubscribe, mode: 'delete', filter: byTenant },
  { name: 'EmbedConfig', model: EmbedConfig, mode: 'delete', filter: byTenant },
  { name: 'Insight', model: Insight, mode: 'delete', filter: byTenant },
  { name: 'MetricDefinition', model: MetricDefinition, mode: 'delete', filter: byTenant },
  { name: 'NotificationPreference', model: NotificationPreference, mode: 'delete', filter: byTenant },

  // Usage and entitlements.
  { name: 'UsageCounter', model: UsageCounter, mode: 'delete', filter: byTenant },
  { name: 'UsageReservation', model: UsageReservation, mode: 'delete', filter: byTenant },
  { name: 'EntitlementOverride', model: EntitlementOverride, mode: 'delete', filter: byTenant },
  { name: 'Subscription', model: Subscription, mode: 'delete', filter: byTenant },

  // Identity: grants, then roles, then accounts.
  { name: 'UserRole', model: UserRole, mode: 'delete', filter: byTenant },
  { name: 'RolePermission', model: RolePermission, mode: 'delete', filter: (ctx) => ({ roleId: { $in: ctx.roleIds } }) },
  { name: 'Role', model: Role, mode: 'delete', filter: byTenant },
  { name: 'User', model: User, mode: 'delete', filter: byTenant },

  // Shared documents that mention the tenant.
  {
    name: 'FeatureFlag',
    model: FeatureFlag,
    mode: 'detach',
    filter: (ctx) => ({ 'rollout.tenantIds': ctx.tenantId }),
    update: (ctx) => ({ $pull: { 'rollout.tenantIds': ctx.tenantId } }),
  },
  { name: 'JobLock', model: JobLock, mode: 'delete', filter: (ctx) => ({ _id: `tenant-members:${ctx.tenantId}` }) },

  // Kept under a retention policy (reported in the verification).
  {
    name: 'AuditLog',
    model: AuditLog,
    mode: 'retain',
    filter: byTenant,
    policy: 'audit_retention (RETENTION_AUDIT_LOG_DAYS)',
    when: (config) => config.retainAuditLogs,
  },
  {
    name: 'AccessLog',
    model: AccessLog,
    mode: 'retain',
    filter: byTenant,
    policy: 'access_log_retention (RETENTION_ACCESS_LOG_DAYS)',
    when: (config) => config.retainAuditLogs,
  },
  {
    name: 'ComplianceLog',
    model: ComplianceLog,
    mode: 'retain',
    filter: (ctx) => ({ subjectId: { $in: [ctx.tenantId, ...ctx.userIds] } }),
    policy: 'compliance_evidence',
    when: () => true,
  },
  {
    name: 'PaymentTransaction',
    model: PaymentTransaction,
    mode: 'retain',
    filter: byTenant,
    policy: 'financial_records (TENANT_PURGE_RETAIN_BILLING_RECORDS)',
    when: (config) => config.retainBillingRecords,
  },
  {
    name: 'SubscriptionHistory',
    model: SubscriptionHistory,
    mode: 'retain',
    filter: byTenant,
    policy: 'financial_records (TENANT_PURGE_RETAIN_BILLING_RECORDS)',
    when: (config) => config.retainBillingRecords,
  },
  {
    name: 'WebhookEvent',
    model: WebhookEvent,
    mode: 'retain',
    filter: (ctx) => ({ tenantId: ctx.tenantObjectId }),
    policy: 'financial_records (TENANT_PURGE_RETAIN_BILLING_RECORDS)',
    when: (config) => config.retainBillingRecords,
  },

  // The workspace record itself, last.
  { name: 'Tenant', model: Tenant, mode: 'delete', filter: (ctx) => ({ _id: ctx.tenantObjectId }) },
]);

/**
 * Models that were considered and hold no tenant content (platform
 * catalogue and job bookkeeping), or are the deletion evidence itself.
 */
export const PURGE_EXEMPT = Object.freeze({
  Admin: 'platform administrators',
  AdminInvitation: 'platform administrator invitations (adminauth)',
  SecurityDetectionCursor: 'detector watermarks without tenant content (detection)',
  SupportImpersonationCounter: 'per-admin daily support session counters (support)',
  AuthCooldown: 'per-account auth throttling without tenant content (adminauth)',
  ConfigRevision: 'platform configuration history (config)',
  EmailTemplate: 'platform email templates (config)',
  JobRun: 'job bookkeeping without tenant content',
  MasterData: 'platform reference data',
  Module: 'permission catalogue',
  Permission: 'permission catalogue',
  TenantDeletion: 'deletion evidence (retention in constants/retention.members.js)',
});

/** Storage key prefixes that hold a tenant's files. */
export const STORAGE_PREFIXES = Object.freeze(
  tenantStoragePrefixes('__TENANT__').map((template) => (tenantId) => template.replace('__TENANT__', String(tenantId))),
);

export default { PURGE_REGISTRY, PURGE_EXEMPT, STORAGE_PREFIXES };
