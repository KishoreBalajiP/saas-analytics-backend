/**
 * Platform Dashboard Validators (Phase 5 - implemented).
 *
 * Declarative query schema for `GET /admin/dashboard/summary`.
 */
export const summarySchema = {
  body: {},
  params: {},
  query: {
    limit: { type: 'integer', min: 1, max: 25 },
  },
};

export default { summarySchema };
