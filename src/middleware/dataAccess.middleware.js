/**
 * rls (roadmap 4.E4): run the rest of the request with an explicit DATA
 * actor, for surfaces whose caller is not a tenant user: API keys query as
 * the member who created the key. Row-level security and dataset grants
 * then follow that member (a key created by someone who is no longer an
 * active member gets the most restrictive scope).
 */

import { runAsDataActor, userDataActor } from '../services/dataAccess.service.js';

/** After `authenticateApiKey()`: the key's creator is the data actor. */
export function apiKeyDataActor(req, _res, next) {
  const actor = userDataActor(req.apiKey?.createdBy ?? null, req.tenant ?? req.apiKey?.tenantId);
  return runAsDataActor(actor, () => next());
}

export default { apiKeyDataActor };
