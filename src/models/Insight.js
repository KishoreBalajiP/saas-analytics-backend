/**
 * Insight (ai-insights): one deterministic observation (period change, top
 * movers, outlier) with the cells it came from, optional checked narration,
 * and its feed state (open / dismissed) and feedback.
 * PLUGINS tenantScope, paginate.  INDEXES { tenantId, dashboardId, createdAt }, { tenantId, metricKey, createdAt }.
 */
import mongoose from 'mongoose';
import { tenantScope, paginate } from './plugins/index.js';

export const INSIGHT_TYPES = Object.freeze(['period_change', 'top_movers', 'outlier']);

const insightSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    dashboardId: { type: String, default: null },
    metricKey: { type: String, default: null },
    connectorId: { type: String, required: true },
    type: { type: String, enum: [...INSIGHT_TYPES], required: true },
    window: { type: mongoose.Schema.Types.Mixed, default: null },
    cells: { type: mongoose.Schema.Types.Mixed, required: true },
    facts: { type: mongoose.Schema.Types.Mixed, default: {} },
    narration: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: ['open', 'dismissed'], default: 'open' },
    dismissedBy: { type: String, default: null },
    feedback: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);
insightSchema.index({ tenantId: 1, dashboardId: 1, createdAt: -1 });
insightSchema.index({ tenantId: 1, metricKey: 1, createdAt: -1 });
insightSchema.plugin(tenantScope);
insightSchema.plugin(paginate);

export const Insight = mongoose.model('Insight', insightSchema);
export default Insight;
