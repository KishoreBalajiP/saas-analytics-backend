/**
 * EmbedConfig (embedding package, roadmap 3.2).
 *
 * Per-tenant embed configuration: the origins allowed to host embeds (used
 * when a token does not carry its own list, and as the ceiling for token
 * origins) and the default theme. One row per tenant. There is no
 * allow-all: an empty list means no origin may host an embed.
 */

import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

export const MODEL_NAME = 'EmbedConfig';
export const EMBED_THEMES = Object.freeze(['light', 'dark', 'auto']);
export const EMBED_CONFIG_LIMITS = Object.freeze({ MAX_ORIGINS: 20 });

const embedConfigSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true, index: true },
    allowedOrigins: { type: [String], default: [] },
    defaultTheme: { type: String, enum: [...EMBED_THEMES], default: 'auto' },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

embedConfigSchema.index({ allowedOrigins: 1 });
embedConfigSchema.plugin(tenantScope);

export const EmbedConfig = mongoose.model(MODEL_NAME, embedConfigSchema);
export default EmbedConfig;
