const tokenRule = { type: 'string', required: true, minLength: 20, maxLength: 512 };
const emailRule = { type: 'email', required: true };

export const previewSchema = { body: {}, params: {}, query: { token: tokenRule } };
export const acceptSchema = {
  body: {
    token: tokenRule,
    name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    password: { type: 'string', required: true, minLength: 8, maxLength: 256 },
  }, params: {}, query: {},
};
export const listSchema = {
  body: {}, params: { id: 'objectId|required' }, query: {
    status: { type: 'string', oneOf: ['pending', 'accepted', 'revoked', 'expired'] },
    page: { type: 'integer', min: 1 }, limit: { type: 'integer', min: 1, max: 100 },
  },
};
export const createSchema = {
  body: { email: emailRule, name: { type: 'string', maxLength: 120 }, roleName: { type: 'string', maxLength: 80 } },
  params: { id: 'objectId|required' }, query: {},
};
export const tenantCreateSchema = {
  body: { email: emailRule, name: { type: 'string', maxLength: 120 }, roleName: { type: 'string', maxLength: 80 } },
  params: {}, query: {},
};
export const resendSchema = {
  body: { invitationId: 'objectId|required' },
  params: { id: 'objectId|required' }, query: {},
};
export const revokeSchema = { body: {}, params: { id: 'objectId|required', invitationId: 'objectId|required' }, query: {} };

export default { previewSchema, acceptSchema, listSchema, createSchema, tenantCreateSchema, resendSchema, revokeSchema };
