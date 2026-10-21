/**
 * DatasetSchema (datasets, roadmap 3.7).
 *
 * Typed schema profiled from a connector's ingested rows. One document per
 * (tenantId, connectorId); `version` increments on every re-profile.
 */

import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

export const MODEL_NAME = 'DatasetSchema';
export const FIELD_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'date', 'datetime']);

const fieldSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: [...FIELD_TYPES], required: true },
    nullable: { type: Boolean, default: false },
    nullRate: { type: Number, default: 0 },
    distinctEstimate: { type: Number, default: 0 },
    personal: { type: Boolean, default: false },
    displayName: { type: String, default: null },
    sample: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const datasetSchemaSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    connectorId: { type: String, required: true },
    version: { type: Number, default: 1 },
    dataVersion: { type: Number, default: 0 },
    profiledAt: { type: Date, default: Date.now },
    fields: { type: [fieldSchema], default: [] },
    dateField: { type: String, default: null },
    keyField: { type: String, default: null },
  },
  { timestamps: true },
);

datasetSchemaSchema.index({ tenantId: 1, connectorId: 1 }, { unique: true });
datasetSchemaSchema.plugin(tenantScope);

export const DatasetSchema = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, datasetSchemaSchema);
export default DatasetSchema;
