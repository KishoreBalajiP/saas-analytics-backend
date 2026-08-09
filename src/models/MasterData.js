/**
 * MasterData (Sprint 5 - implemented).
 *
 * PURPOSE
 *   The global lookup catalogue every other module depends on (countries,
 *   currencies, plans, themes, ...). One document per catalogue entry, keyed by
 *   `catalogue` + `locale` + `code`. Writes are admin-only; reads are cached.
 *
 * WHY A SINGLE COLLECTION
 *   The Phase 1.2 plan sketched "one collection per catalogue". A single
 *   partitioned collection is simpler to operate (one index set, one cache
 *   invalidation path) while still supporting per-catalogue isolation via the
 *   unique index and the `catalogue` query constraint enforced in the
 *   repository.
 *
 * PLUGINS
 *   softDelete, optimisticConcurrency, paginate, audit (module `master_data`).
 *   Deliberately NOT tenantScoped: this is platform reference data shared
 *   across tenants.
 *
 * INDEXES
 *   - unique({ catalogue, locale, code })
 *   - { catalogue: 1, locale: 1, isSystem: -1 }
 */

import mongoose from 'mongoose';
import { softDelete, optimisticConcurrency, paginate, audit } from './plugins/index.js';

export const MODEL_NAME = 'MasterData';

const masterDataSchema = new mongoose.Schema(
  {
    catalogue: { type: String, required: true, trim: true, lowercase: true, index: true },
    code: { type: String, required: true, trim: true, index: true },
    locale: { type: String, default: 'en', index: true },
    name: { type: String, required: true, trim: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    isSystem: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

masterDataSchema.index({ catalogue: 1, locale: 1, code: 1 }, { unique: true });
masterDataSchema.index({ catalogue: 1, locale: 1, isSystem: -1 });

masterDataSchema.plugin(softDelete);
masterDataSchema.plugin(optimisticConcurrency);
masterDataSchema.plugin(paginate);
masterDataSchema.plugin(audit, { module: 'master_data' });

export const MasterDataSchema = masterDataSchema;
export const MasterData = mongoose.model(MODEL_NAME, masterDataSchema);
export default MasterData;
