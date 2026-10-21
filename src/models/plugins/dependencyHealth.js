/**
 * dependencyHealth plugin - "broken because a dependency disappeared".
 *
 * WHY IT EXISTS
 *   Widgets, reports and alerts read from a dataset (connector), directly or
 *   through a widget. When that dataset is deleted they cannot run any more.
 *   Instead of leaving them to fail on every view / schedule tick, the
 *   connector delete cascade marks them broken with a reason, and the UI
 *   shows a clear broken state.
 *
 * FIELDS
 *   - `brokenAt`     - when the dependant broke (null = healthy).
 *   - `brokenReason` - machine-readable reason, e.g. `CONNECTOR_DELETED`.
 *   - `brokenRef`    - what it was pointing at when it broke
 *                      (`connector:<id>` or `widget:<id>`).
 *
 * REPAIR
 *   After a `findOneAndUpdate` (the repositories' update path) whose update
 *   touches one of `referenceFields`, if the document now references
 *   something other than `brokenRef` - the user picked another dataset or
 *   widget - the broken marker is cleared and `onRepaired(doc)` runs (e.g. a
 *   repaired widget repairs the reports and alerts that were broken through
 *   it). Updates that do not touch a reference field (scheduler bookkeeping,
 *   run history...) never clear the marker. Disabled schedules stay
 *   disabled: the user re-enables them deliberately.
 *
 * NO RE-ENABLING WHILE BROKEN
 *   A `findOneAndUpdate` that switches one of `enableFields` back on (an
 *   alert's `enabled`, a report's `schedule.enabled`) is refused with
 *   409 `DEPENDENCY_BROKEN` while the document is broken, unless the same
 *   update points it at something else. Otherwise the scheduler would run it
 *   and fail on every tick.
 *
 * OPTIONS
 *   - `reference(doc) => string|null` - the doc's current dependency ref.
 *   - `referenceFields: string[]`     - paths that can change the reference.
 *   - `enableFields: string[]`        - boolean paths that schedule the doc.
 *   - `label`                         - noun used in the 409 message.
 *   - `onRepaired(doc, model)`        - optional async follow-up.
 */

import ApiError from '../../utils/ApiError.js';

export const BROKEN_REASONS = Object.freeze({
  CONNECTOR_DELETED: 'CONNECTOR_DELETED',
});

export const DEPENDENCY_BROKEN = 'DEPENDENCY_BROKEN';

const CLEARED = Object.freeze({ brokenAt: null, brokenReason: null, brokenRef: null });

/** True when a Mongo update document writes any of `fields` (or a parent / child path). */
export function updateTouchesFields(update, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return true;
  if (!update || typeof update !== 'object') return false;
  if (Array.isArray(update)) return true; // aggregation pipeline: cannot tell, compare the doc
  const paths = [];
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith('$')) {
      if (value && typeof value === 'object') paths.push(...Object.keys(value));
    } else {
      paths.push(key);
    }
  }
  return paths.some((p) => fields.some((f) => p === f || p.startsWith(`${f}.`) || f.startsWith(`${p}.`)));
}

/** `$set` paths plus plain top-level paths of an update document. */
function setsOf(update) {
  const out = {};
  for (const [key, value] of Object.entries(update)) {
    if (key === '$set' && value && typeof value === 'object') Object.assign(out, value);
    else if (!key.startsWith('$')) out[key] = value;
  }
  return out;
}

/** Value an update writes at `path` (directly, or inside a parent object it sets). */
function writtenValue(sets, path) {
  if (Object.hasOwn(sets, path)) return sets[path];
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const parent = parts.slice(0, i).join('.');
    if (!Object.hasOwn(sets, parent)) continue;
    let current = sets[parent];
    for (const key of parts.slice(i)) {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    return current;
  }
  return undefined;
}

/** True when the update switches any of `paths` to `true`. */
export function updateEnables(update, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const sets = setsOf(update);
  return paths.some((path) => writtenValue(sets, path) === true);
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (const key of parts.slice(0, -1)) {
    current[key] = current[key] && typeof current[key] === 'object' ? { ...current[key] } : {};
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

/** Shallow preview of `doc` after `$set` / `$unset` (enough to compute its reference). */
function previewUpdate(doc, update) {
  const next = { ...doc };
  for (const [path, value] of Object.entries(setsOf(update))) setPath(next, path, value);
  for (const path of Object.keys(update.$unset ?? {})) setPath(next, path, undefined);
  return next;
}

export function dependencyHealth(schema, {
  reference,
  referenceFields = [],
  enableFields = [],
  label = 'item',
  onRepaired,
} = {}) {
  schema.add({
    brokenAt: { type: Date, default: null },
    brokenReason: { type: String, default: null },
    brokenRef: { type: String, default: null },
  });

  schema.pre('findOneAndUpdate', async function refuseEnablingWhileBroken() {
    if (enableFields.length === 0 || typeof reference !== 'function') return;
    const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null;
    if (!updateEnables(update, enableFields)) return;
    // A copy: read middleware (softDelete, tenantScope) may add to the filter.
    const current = await this.model.findOne({ ...this.getQuery() }).lean();
    if (!current || !current.brokenAt) return;
    // Re-pointed in the same update: allowed, the post hook repairs it.
    if (reference(previewUpdate(current, update)) !== current.brokenRef) return;
    throw new ApiError(
      409,
      `This ${label} cannot be turned on: the dataset it reads from was deleted. Point it at another dataset or widget first.`,
      { code: DEPENDENCY_BROKEN },
    );
  });

  schema.post('findOneAndUpdate', async function repairWhenReferenceChanges(doc) {
    if (!doc || !doc.brokenAt || typeof reference !== 'function') return;
    const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null;
    if (!updateTouchesFields(update, referenceFields)) return;
    const current = reference(doc);
    if (current && current === doc.brokenRef) return;
    await this.model.updateOne({ _id: doc._id, brokenAt: { $ne: null } }, { $set: { ...CLEARED } });
    if (typeof doc.set === 'function') doc.set({ ...CLEARED });
    else Object.assign(doc, CLEARED);
    if (typeof onRepaired === 'function') await onRepaired(doc, this.model);
  });
}

export default dependencyHealth;
