/**
 * DatasetAccess (roadmap 4.E4, rls).
 *
 * PURPOSE
 *   Per-dataset (connector) access control. A dataset without a row, or with
 *   `restricted: false`, is open to every member allowed to read analytics.
 *   A restricted dataset is visible and queryable only for the grants below
 *   (and for holders of `data_access.configure`).
 *
 * GRANTS
 *   `{ subjectType: 'user'|'role', subjectId, level }` where level is
 *   - `view`   : the dataset is listed, but cannot be queried;
 *   - `query`  : listed and queryable (every query path);
 *   - `manage` : as `query` (reserved for delegated administration).
 *
 * INDEXES
 *   unique(tenantId, connectorId)
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'DatasetAccess';
export const GRANT_LEVELS = Object.freeze(['view', 'query', 'manage']);
export const GRANT_SUBJECTS = Object.freeze(['user', 'role']);

const grantSchema = new mongoose.Schema(
  {
    subjectType: { type: String, enum: [...GRANT_SUBJECTS], required: true },
    subjectId: { type: String, required: true },
    level: { type: String, enum: [...GRANT_LEVELS], required: true },
  },
  { _id: false },
);

const datasetAccessSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    connectorId: { type: String, required: true },
    restricted: { type: Boolean, default: false },
    grants: { type: [grantSchema], default: [] },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

datasetAccessSchema.index({ tenantId: 1, connectorId: 1 }, { unique: true });
datasetAccessSchema.index({ tenantId: 1, restricted: 1 });

datasetAccessSchema.plugin(tenantScope);
datasetAccessSchema.plugin(paginate);
datasetAccessSchema.plugin(optimisticConcurrency);
datasetAccessSchema.plugin(audit, { module: 'data_access' });

export const DatasetAccess = mongoose.model(MODEL_NAME, datasetAccessSchema);
export default DatasetAccess;
