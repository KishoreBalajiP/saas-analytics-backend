/**
 * Workspace Settings Validators.
 *
 * Shallow shape only (422 on a wrong type). Unknown fields and invalid time
 * zone names are rejected by `workspaceSettings.service` with a 400 and
 * field-level errors, because `validate()` drops unknown keys silently.
 */

export const workspaceSettingsUpdateSchema = {
  body: {
    timezone: { type: 'string', maxLength: 64 },
  },
  params: {},
  query: {},
};

export default { workspaceSettingsUpdateSchema };
