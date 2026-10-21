/**
 * Email template for "your workspace data export is ready" (roadmap 2.9,
 * backups). Registered from this file (config package convention) so the
 * outbox can render it by key; platform admins may override it like any
 * other built-in template.
 *
 * The email never carries a download link: downloads need a signed-in
 * member who may export data (or a platform admin), so `location` is the
 * settings page (or the admin tenant page) where the archive is listed.
 */

import { registerBuiltInTemplate } from './index.js';

export const TENANT_EXPORT_READY_TEMPLATE = 'tenant.data_export_ready';

export default registerBuiltInTemplate({
  key: TENANT_EXPORT_READY_TEMPLATE,
  name: 'Workspace data export ready',
  description: 'Sent to the person who requested a workspace data export when the archive is ready.',
  variables: [
    { key: 'exportId', description: 'Export reference', required: true, sample: 'tex_01JABCDEF' },
    { key: 'expiresAt', description: 'When the archive is deleted (ISO timestamp)', required: true, sample: '2026-10-25T10:00:00.000Z' },
    { key: 'location', description: 'Page where the export can be downloaded after signing in', required: true, sample: 'https://app.example.com/settings' },
  ],
  subject: 'Your workspace data export is ready',
  text: [
    'The data export {{exportId}} you requested is ready.',
    'Sign in and open {{location}} to download it before {{expiresAt}}.',
    'For security the download link is only shown to signed-in members who are allowed to export data.',
  ].join('\n'),
});
