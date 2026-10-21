/**
 * Process runtime identity (roadmap 1.4).
 *
 * WHY IT EXISTS
 *   Production runs the HTTP service and the background worker as separate
 *   processes (same image, different start command). Several modules need
 *   to know which role this process plays (do I start queue consumers? the
 *   scheduler?) and a stable id for job-run records and lock owners. This
 *   leaf module answers both without importing anything heavy, so `app.js`
 *   can consult it at import time.
 *
 * ROLES
 *   web    - HTTP + Socket.IO; enqueues work but runs no consumers or cron.
 *   worker - queue consumers + scheduler; no HTTP (`src/worker.js`).
 *   all    - everything (development and single-instance deployments).
 *
 *   The role comes from PROCESS_ROLE (`env.runtime.role`); `src/worker.js`
 *   overrides it to `worker` before it starts anything.
 */

import os from 'node:os';
import env from '../config/env.js';

export const PROCESS_ROLES = Object.freeze(['web', 'worker', 'all']);

let roleOverride = null;
let instanceId = null;

/** @returns {'web'|'worker'|'all'} */
export function getProcessRole() {
  return roleOverride ?? env.runtime.role;
}

/**
 * Force the role for this process (the worker entry point does this).
 *
 * @param {'web'|'worker'|'all'|null} role - null clears the override.
 */
export function setProcessRole(role) {
  if (role !== null && !PROCESS_ROLES.includes(role)) {
    throw new Error(`Invalid process role "${role}"`);
  }
  roleOverride = role;
}

/** True when this process should run queue consumers and the scheduler. */
export function runsBackgroundWork() {
  return getProcessRole() !== 'web';
}

/** Stable identifier for this process (job-run records, lock owners). */
export function getInstanceId() {
  if (!instanceId) {
    instanceId = env.runtime.instanceId || `${os.hostname()}:${process.pid}`;
  }
  return instanceId;
}

export default { PROCESS_ROLES, getProcessRole, setProcessRole, runsBackgroundWork, getInstanceId };
