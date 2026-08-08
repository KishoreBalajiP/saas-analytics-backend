/**
 * ConnectorRow (Sprint 4 - implemented).
 *
 * PURPOSE
 *   A single ingested record produced by a connector sync. This is the
 *   ingestion target for CSV rows and for parsed webhook payloads, so the
 *   downstream analytics (Sprint 9) has a uniform "rows" collection to read
 *   from regardless of source.
 *
 * IDEMPOTENCY
 *   `{ connectorId, sourceRowId }` is unique. The sync engine upserts on that
 *   key, so replaying the same sync job never creates duplicate rows.
 *
 * PLUGINS
 *   tenantScope (rows always belong to the owning tenant), softDelete,
 *   paginate, audit (module `connectors`).
 *
 * INDEXES
 *   - unique({ connectorId: 1, sourceRowId: 1 })
 *   - { tenantId: 1, connectorId: 1, ingestedAt: -1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'ConnectorRow';

const connectorRowSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    connectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Connector', required: true, index: true },
    sourceRowId: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    ingestedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

connectorRowSchema.index({ connectorId: 1, sourceRowId: 1 }, { unique: true });
connectorRowSchema.index({ tenantId: 1, connectorId: 1, ingestedAt: -1 });

connectorRowSchema.plugin(tenantScope);
connectorRowSchema.plugin(softDelete);
connectorRowSchema.plugin(paginate);
connectorRowSchema.plugin(optimisticConcurrency);
connectorRowSchema.plugin(audit, { module: 'connectors' });

export const ConnectorRowSchema = connectorRowSchema;
export const ConnectorRow = mongoose.model(MODEL_NAME, connectorRowSchema);
export default ConnectorRow;
