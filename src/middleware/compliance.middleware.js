/**
 * compliance.middleware.js (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Reads "data subject" status from the compliance store and applies it to
 *   business requests: if a subject requested erasure or processing
 *   restriction, the middleware annotates / short-circuits downstream
 *   services without each module re-checking.
 *
 * RESPONSIBILITY
 *   - `annotate`        adds `req.compliance = { restricted, deleted, ... }`
 *                       for the request actor (or `req.complianceSubject`
 *                       when the caller targets another subject).
 *   - `blockIfDeleted`  410 Gone once a delete request completed.
 *   - `blockIfRestricted` 423 Locked while restriction / consent-withdraw
 *                       is in force.
 *
 * USAGE
 *   ```
 *   router.get('/users/:id',
 *     compliance.annotate,                 // adds req.compliance
 *     compliance.blockIfDeleted,           // 410 if applicable
 *     userController.get);
 *   ```
 *
 * SECURITY RULES
 *   - Fail open for annotation (it only annotates), fail closed for the
 *     blockers (they only act on confirmed state).
 *   - Subject identity is the actor by default; callers can pin another
 *     subject via `req.complianceSubject = { id, type }`.
 */

import ApiError from '../utils/ApiError.js';
import { getActor } from './actor.js';
import * as complianceService from '../services/compliance.service.js';

/**
 * Resolve which subject the compliance state applies to. Prefers the pinned
 * `req.complianceSubject`, then the authenticated actor.
 */
function resolveSubject(req) {
  if (req.complianceSubject && typeof req.complianceSubject === 'object') {
    return {
      subjectId: req.complianceSubject.id,
      subjectType: req.complianceSubject.type === 'tenant' ? 'tenant' : 'user',
    };
  }
  const actor = getActor(req);
  if (!actor) return null;
  if (actor.type === 'admin') return null;
  return { subjectId: actor.id, subjectType: 'user' };
}

/**
 * Annotate the request with the subject's compliance state. Never blocks;
 * later blockers decide.
 */
export async function annotate(req, _res, next) {
  const subject = resolveSubject(req);
  if (!subject) {
    req.compliance = { subjectId: null, subjectType: null, restricted: false, deleted: false, deleteInProgress: false, inProgress: false, activeRequests: 0 };
    return next();
  }
  try {
    req.compliance = await complianceService.getSubjectComplianceState(subject);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * 410 Gone when the subject has been erased (delete request completed).
 * Also blocks while an erasure is in flight to keep reads consistent.
 */
export async function blockIfDeleted(req, _res, next) {
  const subject = resolveSubject(req);
  if (!subject) return next();
  try {
    const state = await complianceService.getSubjectComplianceState(subject);
    if (state.deleted || state.deleteInProgress) {
      return next(ApiError.gone('This subject has been erased or an erasure is in progress'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * 423 Locked when the subject requested processing restriction or withdrew
 * consent (in force until lifted).
 */
export async function blockIfRestricted(req, _res, next) {
  const subject = resolveSubject(req);
  if (!subject) return next();
  try {
    const state = await complianceService.getSubjectComplianceState(subject);
    if (state.restricted) {
      return next(ApiError.locked('Processing is restricted for this subject until they lift the request'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export default {
  annotate,
  blockIfDeleted,
  blockIfRestricted,
  _meta: { phase: '8 - implemented', runOrder: 'after auth, before business logic' },
};
