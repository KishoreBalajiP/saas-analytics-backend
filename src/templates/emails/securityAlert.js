/**
 * Email template for on-call security alert notifications (roadmap 2.6,
 * detection). Registered from this file (config package convention) so the
 * outbox can render it by key; platform admins may override it like any
 * other built-in template.
 *
 * Variables are flat scalars built by
 * `services/securityDetection/notifier.js#buildEmailVariables`: never
 * evidence rows, credentials or webhook URLs.
 */

import { registerBuiltInTemplate } from './index.js';

export const SECURITY_ALERT_TEMPLATE = 'security.alert_raised';

export default registerBuiltInTemplate({
  key: SECURITY_ALERT_TEMPLATE,
  name: 'Security alert raised',
  description: 'Sent to the on-call addresses when a high-severity platform security alert is raised or escalated.',
  variables: [
    { key: 'severity', description: 'Alert severity in capitals', required: true, sample: 'HIGH' },
    { key: 'title', description: 'Alert title', required: true, sample: 'Credential stuffing from one address' },
    { key: 'ruleId', description: 'Detection rule id', required: true, sample: 'auth.credential_stuffing' },
    { key: 'ruleVersion', description: 'Detection rule version', required: true, sample: '1' },
    { key: 'subject', description: 'What the alert is about', required: true, sample: 'ip 203.0.113.5' },
    { key: 'tenant', description: 'Tenant id, or "-" for platform-level alerts', sample: 'ten_123', default: '-' },
    { key: 'firstSeenAt', description: 'First detection (ISO timestamp)', required: true, sample: '2026-10-22T10:00:00.000Z' },
    { key: 'lastSeenAt', description: 'Latest detection (ISO timestamp)', required: true, sample: '2026-10-22T10:05:00.000Z' },
    { key: 'summary', description: 'One-paragraph summary', required: true, sample: '24 failed sign-ins for 12 accounts from 203.0.113.5 in 15 minutes.' },
    { key: 'counts', description: 'Evidence counters, or "-"', sample: 'failures=24, accounts=12', default: '-' },
    { key: 'reviewUrl', description: 'Link to the alert in the admin portal', sample: 'https://app.example.com/admin/security-alerts?alert=abc', default: 'the admin portal (Security alerts)' },
  ],
  subject: '[Security alert] {{severity}}: {{title}}',
  text: [
    'Severity: {{severity}}',
    'Rule: {{ruleId}} (v{{ruleVersion}})',
    'Subject: {{subject}}',
    'Tenant: {{tenant}}',
    'First seen: {{firstSeenAt}}',
    'Last seen: {{lastSeenAt}}',
    '',
    '{{summary}}',
    'Counts: {{counts}}',
    '',
    'Review and acknowledge: {{reviewUrl}}',
  ].join('\n'),
});
