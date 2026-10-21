/**
 * SecurityDetectionCursor (roadmap 2.6 - platform security detection).
 *
 * PURPOSE
 *   The per-rule watermark of the detector job: the instant up to which the
 *   rule's event stream has been evaluated. The next tick evaluates only
 *   events in (watermark, now - settle], so an event is never processed
 *   twice and an outage is caught up (bounded) on the next run.
 *
 * SHAPE
 *   `_id` is the rule id. `ruleVersion` records which version of the rule
 *   advanced the watermark (a version bump keeps the watermark: rules are
 *   re-tuned forward, never replayed over old data).
 *
 * PLUGINS
 *   paginate (a handful of rows; no tenancy).
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'SecurityDetectionCursor';

const securityDetectionCursorSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ruleVersion: { type: Number, default: 1 },
    watermark: { type: Date, required: true },
    lastRunAt: { type: Date, default: null },
    lastDetections: { type: Number, default: 0 },
    lastError: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

securityDetectionCursorSchema.plugin(paginate);

export const SecurityDetectionCursorSchema = securityDetectionCursorSchema;
export const SecurityDetectionCursor =
  mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, securityDetectionCursorSchema);
export default SecurityDetectionCursor;
