/**
 * SecurityDetectionCursor Repository (roadmap 2.6).
 *
 * PURPOSE
 *   Read and advance the per-rule watermark of the detector job. The
 *   watermark only moves forward (`$max`), so a delayed or repeated tick can
 *   never rewind a rule and reprocess its events.
 */

import { SecurityDetectionCursor } from '../models/SecurityDetectionCursor.js';

/** Cursor for a rule, or null before its first evaluation. */
export const get = (ruleId) => SecurityDetectionCursor.findById(ruleId).lean();

/** Every cursor (rule catalogue / monitoring). */
export const listAll = () => SecurityDetectionCursor.find({}).lean();

/**
 * Advance a rule's watermark after a successful evaluation.
 *
 * @param {string} ruleId
 * @param {{ watermark: Date, ruleVersion: number, lastRunAt: Date, detections: number }} state
 */
export const advance = (ruleId, { watermark, ruleVersion, lastRunAt, detections = 0 }) =>
  SecurityDetectionCursor.findOneAndUpdate(
    { _id: ruleId },
    {
      $max: { watermark },
      $set: { ruleVersion, lastRunAt, lastDetections: detections, lastError: null },
    },
    { upsert: true, new: true, lean: true, setDefaultsOnInsert: true },
  );

/**
 * Record a failed evaluation without moving the watermark. A rule that
 * fails on its very first run gets a cursor without a watermark, so the
 * next run still starts from the initial lookback.
 */
export const recordError = (ruleId, { lastRunAt, message, ruleVersion }) =>
  SecurityDetectionCursor.updateOne(
    { _id: ruleId },
    { $set: { lastRunAt, lastError: String(message ?? 'failed').slice(0, 500), ruleVersion } },
    { upsert: true },
  );

export default { get, listAll, advance, recordError };
