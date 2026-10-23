/**
 * AiQuestion (ai-ask): one natural-language question and how it was handled.
 *
 * Holds the plan, validator outcome, dataset ids, latency, token usage and a
 * prompt hash - NEVER result rows. The question text is kept under the
 * retention policy (RETENTION_AI_QUESTIONS_DAYS, constants/retention.ai-ask.js).
 *
 * PLUGINS tenantScope, paginate.  INDEXES { tenantId, createdAt }.
 */
import mongoose from "mongoose";
import { tenantScope, paginate } from "./plugins/index.js";

export const AI_OUTCOMES = Object.freeze([
  "answered",
  "clarify",
  "unanswerable",
  "failed",
]);

const aiQuestionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    actorId: { type: String, default: null },
    question: { type: String, maxlength: 2000, default: "" },
    outcome: { type: String, enum: [...AI_OUTCOMES], required: true },
    reason: { type: String, default: null },
    plan: { type: mongoose.Schema.Types.Mixed, default: null },
    validator: {
      type: new mongoose.Schema(
        { passed: Boolean, repaired: Boolean, errors: [String] },
        { _id: false },
      ),
      default: null,
    },
    datasetIds: [{ type: String }],
    // ai-ask: the earlier question this one follows up on (same tenant + actor).
    previousQuestionId: { type: String, default: null },
    provider: { type: String, default: null },
    model: { type: String, default: null },
    promptHash: { type: String, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },
    latencyMs: { type: Number, default: null },
    rowCount: { type: Number, default: null },
    feedback: {
      type: new mongoose.Schema(
        { rating: String, comment: String, at: Date, by: String },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);
aiQuestionSchema.index({ tenantId: 1, createdAt: -1 });
aiQuestionSchema.plugin(tenantScope);
aiQuestionSchema.plugin(paginate);

export const AiQuestion = mongoose.model("AiQuestion", aiQuestionSchema);
export default AiQuestion;
