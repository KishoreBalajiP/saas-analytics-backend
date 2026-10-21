/**
 * JobRun (roadmap 1.4 - durable jobs).
 *
 * PURPOSE
 *   One record per execution of a scheduled (cron) job: which job, which
 *   process ran it, when it started and finished, how it ended, what it
 *   counted and a sanitised error. Platform-scoped (no tenantId): cron jobs
 *   sweep every tenant.
 *
 * LIFECYCLE
 *   `running` -> `succeeded` | `failed`. A run whose process died stops
 *   renewing `leaseUntil`; the stale-job reaper closes it as `abandoned`.
 *   Finished runs carry `expiresAt` (RETENTION_JOB_RUN_DAYS) and a TTL index
 *   removes them afterwards.
 *
 * PLUGINS
 *   paginate (admin monitoring lists runs).
 *
 * INDEXES
 *   - { job: 1, startedAt: -1 }     latest runs per job (scheduler health)
 *   - { status: 1, leaseUntil: 1 }  reaper scan for stale running records
 *   - { startedAt: -1 }             admin listing
 *   - TTL { expiresAt: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'JobRun';
export const JOB_RUN_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'abandoned']);
export const JOB_RUN_TRIGGERS = Object.freeze(['schedule', 'manual']);

const errorSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    message: { type: String, default: null },
  },
  { _id: false },
);

const jobRunSchema = new mongoose.Schema(
  {
    job: { type: String, required: true, trim: true, maxlength: 64 },
    instanceId: { type: String, default: null },
    trigger: { type: String, enum: [...JOB_RUN_TRIGGERS], default: 'schedule' },
    status: { type: String, enum: [...JOB_RUN_STATUSES], default: 'running' },
    tickAt: { type: Date, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    heartbeatAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    counts: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: errorSchema, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

jobRunSchema.index({ job: 1, startedAt: -1 });
jobRunSchema.index({ status: 1, leaseUntil: 1 });
jobRunSchema.index({ startedAt: -1 });
jobRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

jobRunSchema.plugin(paginate);

export const JobRunSchema = jobRunSchema;
export const JobRun = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, jobRunSchema);
export default JobRun;
