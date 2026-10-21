/**
 * AuthCooldown (auth.15, adminauth).
 *
 * PURPOSE
 *   Shared, persistent cooldown markers for auth emails (verification
 *   resend, admin invitation resend). Stored in MongoDB rather than the
 *   process-local cache, so every instance sees the same cooldown and a
 *   restart does not reset it.
 *
 * DESIGN
 *   - `key` is a caller-built identifier (never a raw email: callers pass a
 *     digest), unique.
 *   - `expiresAt` carries a TTL index, so expired markers purge themselves;
 *     `authCooldown.service.acquire` also takes over an expired marker the
 *     TTL monitor has not removed yet.
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AuthCooldown';

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

schema.index({ key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

schema.plugin(paginate);

export const AuthCooldownSchema = schema;
export const AuthCooldown = mongoose.model(MODEL_NAME, schema);
export default AuthCooldown;
