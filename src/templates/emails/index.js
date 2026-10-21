/**
 * Built-in transactional email templates (roadmap 2.4).
 *
 * PURPOSE
 *   The code-owned default for every transactional email. Platform admins
 *   may override a template's subject / text / HTML per locale over
 *   `/api/v1/email-templates`; `services/emailTemplate.service.js#render`
 *   uses the stored override and falls back to the built-in below.
 *
 * TEMPLATE SHAPE
 *   {
 *     key,            // stable id, `<area>.<email>`
 *     name, description,
 *     variables: [{ key, description, required, sample, default? }],
 *     subject, text, html | null
 *   }
 *   - Placeholders are `{{ variableName }}` only: no logic, no helpers, no
 *     raw-HTML output. Values are HTML-escaped in the HTML part and
 *     stripped of line breaks in the subject.
 *   - `required` variables must appear in the subject or in every body part
 *     of an override (an email without its link is useless), and callers
 *     must supply them.
 *   - `sample` values feed the admin preview; `default` fills an optional
 *     variable the caller did not pass.
 *
 * HOW TO EXTEND
 *   Other modules add their templates with `registerBuiltInTemplate(...)`
 *   from their own file (no need to edit this list), then send with
 *   `emailService.sendTemplate({ to, template: '<key>', variables })`.
 */

const registry = new Map();

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const VAR_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Register (or replace) a built-in template. Validates the definition so a
 * broken registration fails at import time, not at send time.
 *
 * @param {Object} definition
 * @returns {Object} the frozen definition.
 */
export function registerBuiltInTemplate(definition) {
  const { key, name, subject, text, variables = [] } = definition ?? {};
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error(`Invalid email template key "${key}"`);
  if (!name || !subject || !text) throw new Error(`Email template "${key}" needs name, subject and text`);
  for (const variable of variables) {
    if (!VAR_RE.test(variable?.key ?? '')) throw new Error(`Email template "${key}" has an invalid variable name`);
  }
  const frozen = Object.freeze({
    key,
    name,
    description: definition.description ?? '',
    variables: Object.freeze(variables.map((variable) => Object.freeze({
      key: variable.key,
      description: variable.description ?? '',
      required: Boolean(variable.required),
      sample: variable.sample ?? '',
      ...(variable.default !== undefined ? { default: String(variable.default) } : {}),
    }))),
    subject,
    text,
    html: definition.html ?? null,
  });
  registry.set(key, frozen);
  return frozen;
}

/** The built-in definition for `key`, or null. */
export function getBuiltInTemplate(key) {
  return registry.get(key) ?? null;
}

/** Every built-in template, sorted by key. */
export function listBuiltInTemplates() {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------ built-ins ------------------------------ */
// Texts match the messages the platform sends today, so an un-customised
// template renders exactly what users already receive.

registerBuiltInTemplate({
  key: 'auth.password_reset',
  name: 'Password reset',
  description: 'Sent when a password reset is requested for an active tenant user or platform admin.',
  variables: [
    { key: 'resetUrl', description: 'Single-use link to choose a new password', required: true, sample: 'https://app.example.com/login/reset?token=sample-token' },
    { key: 'expiresIn', description: 'How long the link stays valid (configurable, e.g. "1 hour")', sample: '1 hour', default: '15 minutes' },
  ],
  subject: 'Reset your password',
  text: [
    'A password reset was requested for this account.',
    'Use this link to choose a new password:',
    '',
    '{{resetUrl}}',
    '',
    'This link expires in {{expiresIn}} and can only be used once.',
    'If you did not request a reset, you can safely ignore this email.',
  ].join('\n'),
});

registerBuiltInTemplate({
  key: 'auth.email_verification',
  name: 'Workspace email verification',
  description: 'Sent to a new workspace owner to verify their email address and finish creating the workspace.',
  variables: [
    { key: 'name', description: 'Recipient name', sample: 'Ada', default: 'there' },
    { key: 'verificationUrl', description: 'Single-use verification link', required: true, sample: 'https://app.example.com/register?token=sample-token' },
    { key: 'expiresIn', description: 'How long the link stays valid (configurable, e.g. "1 hour")', sample: '1 hour', default: '15 minutes' },
  ],
  subject: 'Verify your Analivo workspace email',
  text: [
    'Hi {{name}},',
    '',
    'Welcome to Analivo. Verify your email address to finish creating your workspace.',
    '',
    '{{verificationUrl}}',
    '',
    'This link expires in {{expiresIn}} and can only be used once.',
  ].join('\n'),
});

registerBuiltInTemplate({
  key: 'tenant.invitation',
  name: 'Workspace invitation',
  description: 'Sent when someone is invited to join a workspace.',
  variables: [
    { key: 'tenantName', description: 'Workspace name', required: true, sample: 'Acme Analytics' },
    { key: 'acceptUrl', description: 'Single-use invitation link', required: true, sample: 'https://app.example.com/invite/accept?token=sample-token' },
    { key: 'expiresIn', description: 'How long the link stays valid (configurable, e.g. "1 hour")', sample: '1 hour', default: '15 minutes' },
  ],
  subject: 'You are invited to Analivo',
  text: 'You have been invited to {{tenantName}}. Accept your invitation: {{acceptUrl}}\n\nThis link expires in {{expiresIn}} and can only be used once.',
});

registerBuiltInTemplate({
  key: 'alert.triggered',
  name: 'Alert triggered',
  description: 'Sent to email recipients of an alert rule when it fires.',
  variables: [
    { key: 'alertName', description: 'Alert rule name', required: true, sample: 'Revenue below target' },
    { key: 'message', description: 'What triggered the alert', required: true, sample: 'Revenue 812 is below the threshold 1000.' },
  ],
  subject: 'Alert triggered: {{alertName}}',
  text: '{{message}}',
});

// delivery (roadmap 3.4): scheduled report delivery.
registerBuiltInTemplate({
  key: 'report.delivered',
  name: 'Scheduled report delivered',
  description: 'Sent to the recipients of a scheduled report when a run is ready.',
  variables: [
    { key: 'reportName', description: 'Report name', required: true, sample: 'Monthly revenue' },
    { key: 'rowCount', description: 'Rows in the file', required: false, sample: '120' },
    { key: 'downloadUrl', description: 'Signed download link, or "attached"', required: false, sample: 'attached' },
    { key: 'unsubscribeUrl', description: 'Unsubscribe link (external recipients)', required: false, sample: '' },
  ],
  subject: 'Report ready: {{reportName}}',
  text: 'Your scheduled report "{{reportName}}" is ready ({{rowCount}} rows).\nFile: {{downloadUrl}}\n{{unsubscribeUrl}}',
});

// adminauth (roadmap 2.2): admin portal invitations and admin-assisted resets.
registerBuiltInTemplate({
  key: 'admin.invitation',
  name: 'Admin portal invitation',
  description: 'Sent to a new platform administrator to choose a password (and set up MFA when required).',
  variables: [
    { key: 'name', description: 'Invitee name', sample: 'Ada', default: 'there' },
    { key: 'adminType', description: 'Administrator type (super, platform, support, auditor)', required: true, sample: 'platform' },
    { key: 'acceptUrl', description: 'Single-use invitation link', required: true, sample: 'https://app.example.com/admin/accept-invite?token=sample-token' },
    { key: 'expiresIn', description: 'How long the link stays valid', sample: '3 days', default: '3 days' },
    { key: 'mfaNotice', description: 'Sentence about mandatory MFA (empty when not required)', sample: 'Your role requires multi-factor authentication: you will set up an authenticator app right after choosing your password.', default: '' },
  ],
  subject: 'You are invited to the Analivo admin portal',
  text: [
    'Hi {{name}},',
    '',
    'You have been invited to the Analivo admin portal as a {{adminType}} administrator.',
    'Accept the invitation and choose your password here:',
    '',
    '{{acceptUrl}}',
    '',
    'This link expires in {{expiresIn}} and can only be used once.',
    '{{mfaNotice}}',
    'If you did not expect this invitation, you can ignore this email.',
  ].join('\n'),
});

registerBuiltInTemplate({
  key: 'admin.password_reset_by_admin',
  name: 'Admin password reset by another administrator',
  description: 'Sent when a super administrator resets another administrator\'s password.',
  variables: [
    { key: 'resetUrl', description: 'Single-use link to choose a new password', required: true, sample: 'https://app.example.com/admin/reset-password?token=sample-token' },
    { key: 'expiresIn', description: 'How long the link stays valid', sample: '1 hour', default: '1 hour' },
  ],
  subject: 'Your admin portal password was reset',
  text: [
    'Another administrator reset the password of your admin portal account.',
    'Your previous password no longer works. Use this link to choose a new one:',
    '',
    '{{resetUrl}}',
    '',
    'This link expires in {{expiresIn}} and can only be used once.',
    'If you did not expect this, contact your security team.',
  ].join('\n'),
});

// billing (roadmap 3.1): prepaid-term renewal reminders and grace notices.
registerBuiltInTemplate({
  key: 'billing.renewal_reminder',
  name: 'Plan renewal reminder',
  description: 'Sent before a prepaid plan term ends. Terms never renew automatically.',
  variables: [
    { key: 'tenantName', description: 'Workspace name', required: true, sample: 'Acme Analytics' },
    { key: 'planName', description: 'Plan name', required: true, sample: 'Pro' },
    { key: 'periodEnd', description: 'Last day of the current term (YYYY-MM-DD, UTC)', required: true, sample: '2026-11-30' },
    { key: 'daysLeft', description: 'Whole days until the term ends', sample: '7', default: 'a few' },
    { key: 'billingUrl', description: 'Link to the workspace billing page', required: true, sample: 'https://app.example.com/billing' },
  ],
  subject: 'Your {{planName}} plan for {{tenantName}} ends on {{periodEnd}}',
  text: [
    'The prepaid {{planName}} term of {{tenantName}} ends on {{periodEnd}} ({{daysLeft}} days left).',
    'Plans do not renew automatically. To keep your plan, buy the next term here:',
    '',
    '{{billingUrl}}',
    '',
    'If you do nothing, a short grace period follows; after it the workspace becomes read-only until a term is bought.',
  ].join('\n'),
});

registerBuiltInTemplate({
  key: 'billing.trial_ending',
  name: 'Trial ending',
  description: 'Sent before a plan trial ends.',
  variables: [
    { key: 'tenantName', description: 'Workspace name', required: true, sample: 'Acme Analytics' },
    { key: 'planName', description: 'Plan name', required: true, sample: 'Pro' },
    { key: 'periodEnd', description: 'Last day of the trial (YYYY-MM-DD, UTC)', required: true, sample: '2026-11-30' },
    { key: 'daysLeft', description: 'Whole days until the trial ends', sample: '3', default: 'a few' },
    { key: 'billingUrl', description: 'Link to the workspace billing page', required: true, sample: 'https://app.example.com/billing' },
  ],
  subject: 'Your {{planName}} trial for {{tenantName}} ends on {{periodEnd}}',
  text: [
    'The {{planName}} trial of {{tenantName}} ends on {{periodEnd}} ({{daysLeft}} days left).',
    'Buy a term to keep the plan, otherwise the workspace moves to the free plan:',
    '',
    '{{billingUrl}}',
  ].join('\n'),
});

registerBuiltInTemplate({
  key: 'billing.payment_overdue',
  name: 'Plan term ended (grace period)',
  description: 'Sent when a prepaid term ended without renewal and the grace period started.',
  variables: [
    { key: 'tenantName', description: 'Workspace name', required: true, sample: 'Acme Analytics' },
    { key: 'planName', description: 'Plan name', required: true, sample: 'Pro' },
    { key: 'graceEndsAt', description: 'Last day of the grace period (YYYY-MM-DD, UTC)', required: true, sample: '2026-12-07' },
    { key: 'billingUrl', description: 'Link to the workspace billing page', required: true, sample: 'https://app.example.com/billing' },
  ],
  subject: 'Action needed: the {{planName}} term of {{tenantName}} has ended',
  text: [
    'The prepaid {{planName}} term of {{tenantName}} has ended without renewal.',
    'Your plan stays available until {{graceEndsAt}}. After that the workspace becomes read-only until a term is bought:',
    '',
    '{{billingUrl}}',
  ].join('\n'),
});

export default { registerBuiltInTemplate, getBuiltInTemplate, listBuiltInTemplates };
