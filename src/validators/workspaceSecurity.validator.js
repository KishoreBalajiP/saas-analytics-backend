/**
 * Workspace Security Validators (roadmap 4.E1, mfa-tenant).
 *
 * Shapes for `/api/v1/workspace/security`. The policy body is checked
 * strictly by the service as well (it must be a boolean).
 */

export const policyUpdateSchema = {
  body: {
    mfaRequired: { type: 'boolean', required: true },
  },
  params: {},
  query: {},
};

export const memberMfaResetSchema = {
  body: {
    // Why the reset happens; stored with the security event.
    reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
  },
  params: {
    userId: { type: 'string', required: true, pattern: '^[0-9a-fA-F]{24}$' },
  },
  query: {},
};

export default { policyUpdateSchema, memberMfaResetSchema };
