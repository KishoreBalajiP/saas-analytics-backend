/**
 * Setting Validators (architecture placeholder).
 *
 * PURPOSE
 *   Declarative schemas for `/settings`. Enforces type-bound value
 *   coercion via rules (the engine handles string/number/boolean/json/
 *   duration).
 *
 * RESPONSIBILITY (planned, NO validation logic yet)
 *   - createSettingSchema   { key, scope, tenantId?, type, value, isSecret?, isReadonly? }
 *   - updateSettingSchema   { value, version }
 *
 * PHASE 1.2 STATUS
 *   Empty schemas; engine accepts any payload. Real rules land with the
 *   setting service.
 */

/** @type {import('../index.js').Schema} */
export const createSettingSchema = { body: {}, params: {}, query: {} };

/** @type {import('../index.js').Schema} */
export const updateSettingSchema = { body: {}, params: {}, query: {} };

export default {
  createSettingSchema,
  updateSettingSchema,
  _meta: { phase: '1.2 - placeholder schemas' },
};
