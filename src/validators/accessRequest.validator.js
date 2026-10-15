export const submitSchema = {
  body: {
    name: { type: 'string', required: true, minLength: 2, maxLength: 120 },
    email: 'email|required',
    workspaceName: { type: 'string', required: true, minLength: 2, maxLength: 120 },
    reason: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

export const listSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: ['pending', 'approved', 'rejected'] },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export const decisionSchema = {
  body: {
    tenantId: { type: 'objectId', required: true },
    roleName: { type: 'string', maxLength: 80 },
    note: { type: 'string', maxLength: 500 },
  },
  params: { id: 'objectId|required' },
  query: {},
};

export const rejectSchema = {
  body: { note: { type: 'string', maxLength: 500 } },
  params: { id: 'objectId|required' },
  query: {},
};

export default { submitSchema, listSchema, decisionSchema, rejectSchema };
