/**
 * Embed Service (roadmap 3.2 - signed, origin-bound embed sessions).
 *
 * PURPOSE
 *   Business layer for embedding dashboards in other sites and for public
 *   share links.
 *
 * FLOW
 *   1. Mint (server side). The host application's backend calls
 *      `POST /embed/tokens` (tenant user with embed.create) or
 *      `POST /embed/api/tokens` (API key with the `embed:create` scope).
 *      The result is a signed JWT (audience `embed`, jti = EmbedToken id)
 *      bound to tenant, dashboard (optional widget), allowed origins,
 *      locked filters and row-level params. Only its SHA-256 is stored.
 *   2. Handshake. The host page passes the token to the Analivo iframe via
 *      postMessage (never in a URL). The iframe exchanges it with
 *      `POST /embed/public/session` for a short-lived embed session JWT.
 *      The effective origin (the `Origin` header, or for the Analivo embed
 *      page the browser-verified parent origin) must be bound to the token.
 *   3. View. `POST /embed/public/view` with `Authorization: Bearer <session>`
 *      renders the dashboard/widget. Locked filters are AND-ed with any
 *      viewer filters and the locked date range wins.
 *
 * SECURITY CONTRACT
 *   - No allow-all: a token without bound origins (token list or tenant
 *     config) cannot be minted.
 *   - Every exchange and view re-checks: token row active and unexpired,
 *     tenant active (suspension stops embeds immediately), dashboard
 *     published, origin bound.
 *   - Legacy URL-path tokens (`GET /embed/:token`) are refused with 410
 *     `EMBED_TOKEN_MIGRATED`.
 *   - Public share payloads are allow-listed (`sharePayload`).
 */

import { generateToken, sha256 } from '../utils/crypto.js';
import env from '../config/env.js';
import embedTokenRepository from '../repositories/embedToken.repository.js';
import dashboardService from './dashboard.service.js';
import { EmbedToken, EMBED_TOKEN_STATUSES } from '../models/EmbedToken.js';
import { EmbedConfig, EMBED_THEMES, EMBED_CONFIG_LIMITS } from '../models/EmbedConfig.js';
import ApiError from '../utils/ApiError.js';
import tenantRepository from '../repositories/tenant.repository.js';
import { securityEvent } from './securityEvent.service.js';
import * as jwt from '../utils/jwt.js';
// rls: an embed or share link shows what its creator may see.
import { runAsDataActor, userDataActor } from './dataAccess.service.js';
// billing: embeds stop serving once the plan no longer includes embedding.
import entitlementService from './entitlement.service.js';

const TOKEN_TYP = 'embed_token';
const SESSION_TYP = 'embed_session';

/** Typed embed errors (stable codes for the SDK). */
const err = {
  invalid: () => new ApiError(401, 'Invalid or expired embed token', { code: 'EMBED_TOKEN_INVALID' }),
  origin: () => new ApiError(403, 'This origin is not allowed to host the embed', { code: 'EMBED_ORIGIN_NOT_ALLOWED' }),
  session: () => new ApiError(401, 'Invalid or expired embed session', { code: 'EMBED_SESSION_INVALID' }),
  migrated: () => new ApiError(410, 'URL-path embed tokens are no longer accepted; mint a signed embed token and use the embed SDK', { code: 'EMBED_TOKEN_MIGRATED' }),
  share: () => new ApiError(404, 'Share link not found or expired', { code: 'SHARE_LINK_INVALID' }),
};

/* ------------------------------- origins ---------------------------------- */

/**
 * Normalise an origin to `scheme://host[:port]`. Only https origins, plus
 * http for localhost during development. Returns null when invalid.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 255) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin === 'null' || url.username || url.password) return null;
  // An origin has no path, query or fragment (a bare trailing slash is fine).
  if (url.pathname !== '/' || url.search || url.hash) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}

function normalizeOrigins(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw ApiError.badRequest('Validation failed', [{ field, message: 'must be an array of origins' }]);
  if (list.length > EMBED_CONFIG_LIMITS.MAX_ORIGINS) {
    throw ApiError.badRequest('Validation failed', [{ field, message: `at most ${EMBED_CONFIG_LIMITS.MAX_ORIGINS} origins` }]);
  }
  const out = [];
  list.forEach((o, i) => {
    const n = normalizeOrigin(o);
    if (!n) throw ApiError.badRequest('Validation failed', [{ field: `${field}[${i}]`, message: 'must be an https origin such as https://app.example.com' }]);
    if (!out.includes(n)) out.push(n);
  });
  return out;
}

/** Analivo's own frontend origins (the embed iframe page runs there). */
function isPlatformOrigin(origin) {
  return Boolean(origin) && env.cors.origins.includes(origin);
}

/**
 * The origin to check against a token's binding. Calls from the Analivo
 * embed page carry the parent (host) origin it received from the browser
 * on the postMessage event; anything else is judged by its Origin header.
 */
export function effectiveOrigin({ origin, parentOrigin }) {
  if (isPlatformOrigin(origin)) return normalizeOrigin(parentOrigin);
  return normalizeOrigin(origin);
}

/**
 * Preflight helper: true when some live token or tenant config binds this
 * origin (or it is Analivo's own frontend). The per-token check happens on
 * the actual request.
 */
export async function isOriginKnown(origin) {
  const n = normalizeOrigin(origin);
  if (!n) return false;
  if (isPlatformOrigin(n)) return true;
  const token = await EmbedToken.exists({ allowedOrigins: n, status: 'active', expiresAt: { $gt: new Date() }, deletedAt: null });
  if (token) return true;
  return Boolean(await EmbedConfig.exists({ allowedOrigins: n }));
}

/* ------------------------------ tenant config ----------------------------- */

/** Per-tenant embed configuration. */
export async function getConfig({ tenantId }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const doc = await EmbedConfig.findOne({ tenantId: String(tenantId) }).lean();
  return { allowedOrigins: doc?.allowedOrigins ?? [], defaultTheme: doc?.defaultTheme ?? 'auto' };
}

/** Replace the tenant's embed configuration (strict fields). */
export async function updateConfig({ tenantId, actorId = null, patch = {} } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw ApiError.badRequest('Validation failed', [{ field: 'body', message: 'must be an object' }]);
  const unknown = Object.keys(patch).filter((k) => !['allowedOrigins', 'defaultTheme'].includes(k));
  if (unknown.length) throw ApiError.badRequest('Validation failed', unknown.map((field) => ({ field, message: 'is not a recognised setting' })));
  const set = { updatedBy: actorId };
  if (patch.allowedOrigins !== undefined) set.allowedOrigins = normalizeOrigins(patch.allowedOrigins, 'allowedOrigins');
  if (patch.defaultTheme !== undefined) {
    if (!EMBED_THEMES.includes(patch.defaultTheme)) throw ApiError.badRequest('Validation failed', [{ field: 'defaultTheme', message: `must be one of ${EMBED_THEMES.join(', ')}` }]);
    set.defaultTheme = patch.defaultTheme;
  }
  await EmbedConfig.updateOne({ tenantId: String(tenantId) }, { $set: set, $setOnInsert: { tenantId: String(tenantId) } }, { upsert: true });
  return getConfig({ tenantId });
}

/* --------------------------------- minting -------------------------------- */

function validateTtl(ttlSec, max = env.security.embed.maxTtlSec) {
  if (!Number.isFinite(ttlSec) || ttlSec < 60) throw ApiError.badRequest('TTL must be at least 60 seconds');
  if (ttlSec > max) throw ApiError.badRequest(`TTL exceeds maximum of ${max} seconds`);
}

/** Validate locked filters (engine filter envelope) and params ({field: scalar}). */
function normalizeLocks({ lockedFilters, params }) {
  const locked = lockedFilters === undefined || lockedFilters === null
    ? null
    : dashboardService.sanitizeFilterEnvelope(lockedFilters, 'lockedFilters.');
  if (locked?.filtersOp === 'or' && (locked.filters?.length ?? 0) > 1) {
    throw ApiError.badRequest('Validation failed', [{ field: 'lockedFilters.filtersOp', message: "locked filters are AND-ed; use 'and' (or an 'in' filter)" }]);
  }
  let cleanParams = null;
  if (params !== undefined && params !== null) {
    if (typeof params !== 'object' || Array.isArray(params)) throw ApiError.badRequest('Validation failed', [{ field: 'params', message: 'must be an object of field: value' }]);
    cleanParams = {};
    for (const [k, v] of Object.entries(params)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/u.test(k) || !['string', 'number', 'boolean'].includes(typeof v)) {
        throw ApiError.badRequest('Validation failed', [{ field: `params.${k}`, message: 'must be a field name with a string, number or boolean value' }]);
      }
      cleanParams[k] = v;
    }
  }
  return { locked, params: cleanParams };
}

async function loadPublishedDashboard({ tenantId, dashboardId, widgetId }) {
  const { dashboard } = await dashboardService.getDashboard({ tenantId, dashboardId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  if (dashboard.status !== 'published') throw ApiError.badRequest('Only published dashboards can be embedded');
  if (widgetId) {
    const widget = await dashboardService.getWidget({ tenantId, dashboardId, widgetId });
    if (!widget) throw ApiError.notFound('Widget not found');
  }
  return dashboard;
}

function redact(t) {
  return {
    id: t._id,
    kind: t.kind ?? 'embed',
    name: t.name,
    dashboardId: t.dashboardId,
    widgetId: t.widgetId,
    allowedOrigins: t.allowedOrigins ?? [],
    lockedFilters: t.lockedFilters ?? null,
    params: t.params ?? null,
    theme: t.theme ?? 'auto',
    expiresAt: t.expiresAt,
    status: t.status,
    lastUsedAt: t.lastUsedAt ?? null,
    createdAt: t.createdAt,
  };
}

/**
 * Mint a signed embed token for a published dashboard (optionally one widget).
 * @returns {Promise<{ token: Object, secret: string }>} secret is the signed JWT.
 */
export async function createEmbedToken({
  tenantId, dashboardId, widgetId = null, name = '', ttlSec = null, actorId = null,
  allowedOrigins, lockedFilters, params, theme, via = 'user',
} = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  await loadPublishedDashboard({ tenantId, dashboardId, widgetId });

  const config = await getConfig({ tenantId });
  let origins = normalizeOrigins(allowedOrigins, 'allowedOrigins');
  if (origins.length && config.allowedOrigins.length) {
    const outside = origins.filter((o) => !config.allowedOrigins.includes(o));
    if (outside.length) throw ApiError.badRequest('Validation failed', [{ field: 'allowedOrigins', message: `not in the workspace embed allow-list: ${outside.join(', ')}` }]);
  }
  if (!origins.length) origins = config.allowedOrigins;
  if (!origins.length) {
    throw ApiError.badRequest('Validation failed', [{ field: 'allowedOrigins', message: 'bind at least one origin (on the token or in the workspace embed settings)' }]);
  }
  const { locked, params: cleanParams } = normalizeLocks({ lockedFilters, params });
  if (theme !== undefined && theme !== null && !EMBED_THEMES.includes(theme)) {
    throw ApiError.badRequest('Validation failed', [{ field: 'theme', message: `must be one of ${EMBED_THEMES.join(', ')}` }]);
  }

  const activeCount = await embedTokenRepository.countActiveByDashboard(dashboardId);
  if (activeCount >= env.security.embed.maxActivePerDashboard) {
    throw ApiError.conflict(`Active embed token limit reached for this dashboard (${env.security.embed.maxActivePerDashboard})`);
  }

  const effectiveTtl = ttlSec ?? env.security.embed.defaultTtlSec;
  validateTtl(effectiveTtl);
  const expiresAt = new Date(Date.now() + effectiveTtl * 1000);

  // The row exists first so its id is the JWT's jti; the hash is filled in
  // once the JWT is signed (placeholder is a random unguessable value).
  const doc = await embedTokenRepository.create({
    tenantId: String(tenantId),
    dashboardId,
    widgetId,
    name,
    kind: 'embed',
    tokenHash: sha256(generateToken(32)),
    allowedOrigins: origins,
    lockedFilters: locked,
    params: cleanParams,
    theme: theme ?? config.defaultTheme,
    status: 'active',
    expiresAt,
    createdBy: actorId,
  });
  const secret = await jwt.sign({
    payload: { typ: TOKEN_TYP, tid: String(tenantId), dash: String(dashboardId), wid: widgetId ? String(widgetId) : null },
    audience: jwt.JWT_AUDIENCES.EMBED,
    expiresIn: effectiveTtl,
    jwtId: String(doc._id),
  });
  await embedTokenRepository.update(doc._id, { tokenHash: sha256(secret) });

  await securityEvent('EMBED_TOKEN_CREATED', {
    tenantId: String(tenantId),
    resource: { type: 'embed_token', id: String(doc._id) },
    metadata: {
      tokenId: String(doc._id), name: doc.name, via,
      dashboardId: String(dashboardId), widgetId: widgetId ? String(widgetId) : null,
      allowedOrigins: origins, expiresAt: doc.expiresAt,
    },
  });

  return { token: redact(doc), secret };
}

/** List embed tokens and share links for a tenant. */
export async function listEmbedTokens({ tenantId, dashboardId, page = 1, limit = 20 } = {}) {
  const result = await embedTokenRepository.list({ tenantId, dashboardId, page, limit });
  return { ...result, docs: result.docs.map(redact) };
}

/** Get a single token (redacted). */
export async function getEmbedToken({ tenantId, tokenId }) {
  const doc = await embedTokenRepository.findById(tokenId, { tenantId });
  return doc ? redact(doc) : null;
}

/** Revoke an embed token or share link. */
export async function revokeEmbedToken({ tenantId, tokenId, actorId = null, reason = '' } = {}) {
  const doc = await embedTokenRepository.findById(tokenId, { tenantId });
  if (!doc || doc.status === 'revoked') return null;
  await embedTokenRepository.update(tokenId, {
    status: 'revoked', revokedAt: new Date(), revokedReason: reason, revokedBy: actorId, updatedBy: actorId,
  });
  await securityEvent('EMBED_TOKEN_REVOKED', {
    tenantId: String(tenantId),
    resource: { type: 'embed_token', id: String(doc._id) },
    reason: reason || null,
    metadata: { tokenId: String(doc._id), name: doc.name, kind: doc.kind ?? 'embed', dashboardId: doc.dashboardId ? String(doc.dashboardId) : null },
  });
  return { id: doc._id, revoked: true };
}

/* ------------------------------- resolution ------------------------------- */

/** Load a live token row and verify tenant + dashboard state. */
async function liveRow(row, { kind }) {
  if (!row || (row.kind ?? 'embed') !== kind || row.status !== 'active' || row.deletedAt || row.expiresAt <= new Date()) return null;
  const tenant = await tenantRepository.findById(row.tenantId).catch(() => null);
  if (!tenant || tenant.status !== 'active') return null;
  const found = await dashboardService.getDashboard({ tenantId: row.tenantId, dashboardId: row.dashboardId }).catch(() => null);
  if (!found?.dashboard || found.dashboard.status !== 'published') return null;
  return row;
}

/** Verify a signed embed token JWT and return its live row. */
async function resolveSigned(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) throw err.invalid();
  let payload;
  try {
    ({ payload } = await jwt.verify({ token, audience: jwt.JWT_AUDIENCES.EMBED }));
  } catch {
    throw err.invalid();
  }
  if (payload.typ !== TOKEN_TYP || !payload.jti || !payload.tid) throw err.invalid();
  const row = await embedTokenRepository.findById(payload.jti, { tenantId: payload.tid }).catch(() => null);
  if (!row || row.tokenHash !== sha256(token)) throw err.invalid();
  if (!(await liveRow(row, { kind: 'embed' }))) throw err.invalid();
  return row;
}

/** Legacy URL-path tokens are no longer accepted. */
export async function resolveToken() {
  throw err.migrated();
}

/**
 * Exchange a signed embed token for a short-lived embed session.
 * @returns {Promise<{ sessionToken, expiresAt, theme, widgetId }>}
 */
export async function exchangeSession({ token, origin, parentOrigin }) {
  const row = await resolveSigned(token);
  const eff = effectiveOrigin({ origin, parentOrigin });
  if (!eff || !(row.allowedOrigins ?? []).includes(eff)) throw err.origin();
  const ttl = Math.max(60, Math.min(env.security.embed.sessionTtlSec, Math.floor((row.expiresAt - Date.now()) / 1000)));
  const sessionToken = await jwt.sign({
    payload: { typ: SESSION_TYP, tid: String(row.tenantId), eid: String(row._id), org: eff },
    audience: jwt.JWT_AUDIENCES.EMBED,
    expiresIn: ttl,
  });
  embedTokenRepository.update(row._id, { lastUsedAt: new Date() }).catch(() => {});
  return { sessionToken, expiresAt: new Date(Date.now() + ttl * 1000), theme: row.theme ?? 'auto', widgetId: row.widgetId ? String(row.widgetId) : null };
}

/** Verify an embed session JWT; re-checks the token row on every call. */
export async function verifySession({ sessionToken, origin, parentOrigin }) {
  let payload;
  try {
    ({ payload } = await jwt.verify({ token: sessionToken, audience: jwt.JWT_AUDIENCES.EMBED }));
  } catch {
    throw err.session();
  }
  if (payload.typ !== SESSION_TYP || !payload.eid || !payload.tid) throw err.session();
  const row = await embedTokenRepository.findById(payload.eid, { tenantId: payload.tid }).catch(() => null);
  if (!(await liveRow(row, { kind: 'embed' }))) throw err.session();
  const eff = effectiveOrigin({ origin, parentOrigin });
  if (!eff || eff !== payload.org || !(row.allowedOrigins ?? []).includes(eff)) throw err.origin();
  return row;
}

/* --------------------------------- views ---------------------------------- */

/**
 * Combine viewer filters with the token's locks. Viewer filters are always
 * AND-ed (a viewer `filtersOp: 'or'` cannot widen the locked set); the
 * locked date range replaces any viewer date range.
 */
export function combineFilters(viewer, row) {
  const v = viewer && typeof viewer === 'object' && !Array.isArray(viewer) ? viewer : {};
  const locked = row.lockedFilters ?? {};
  const paramFilters = Object.entries(row.params ?? {}).map(([field, value]) => ({ field, op: 'eq', value }));
  const filters = [
    ...(Array.isArray(v.filters) ? v.filters : []),
    ...(Array.isArray(locked.filters) ? locked.filters : []),
    ...paramFilters,
  ];
  // Locked envelopes only support `and` (validated at mint), so one AND
  // group holds viewer and locked filters together.
  const out = {};
  if (filters.length) { out.filters = filters; out.filtersOp = 'and'; }
  const dateRange = locked.dateRange ?? v.dateRange;
  if (dateRange) out.dateRange = dateRange;
  return out;
}

function publicDashboard(dashboard) {
  return {
    id: String(dashboard._id),
    name: dashboard.name,
    description: dashboard.description ?? '',
    layout: dashboard.layout,
    updatedAt: dashboard.updatedAt,
  };
}

// vizbuilder: provenance (dataset names, versions) is for workspace members, not public embeds.
function publicResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { provenance: _provenance, ...rest } = result;
  return rest;
}

/** Run the dashboard (or the one widget) with the combined filter envelope. */
async function runView(row, viewerFilters) {
  if (!(await entitlementService.hasFeature({ tenantId: String(row.tenantId), feature: 'embedding' }))) {
    throw ApiError.notFound('Embed not found');
  }
  // rls: the creator's data access applies, never the viewer's input.
  return runAsDataActor(userDataActor(row.createdBy ?? null, String(row.tenantId)), () => renderView(row, viewerFilters));
}

async function renderView(row, viewerFilters) {
  const overrides = combineFilters(viewerFilters, row);
  const tenantId = String(row.tenantId);
  const dashboardId = String(row.dashboardId);
  const { dashboard } = await dashboardService.getDashboard({ tenantId, dashboardId });
  const ids = row.widgetId
    ? [String(row.widgetId)]
    : (await dashboardService.listWidgets({ tenantId, dashboardId, page: 1, limit: 50 })).docs.map((w) => String(w._id));
  const widgets = [];
  for (const widgetId of ids) {
    try {
      const r = await dashboardService.executeWidget({ tenantId, dashboardId, widgetId, overrides, actorType: 'embed' });
      widgets.push({ widgetId: r.widgetId, name: r.name, type: r.type, status: 'ok', result: publicResult(r.result) });
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 400) throw e; // bad viewer filter: typed 400
      widgets.push({ widgetId, status: 'error', error: { message: 'Widget could not be rendered' } });
    }
  }
  return { dashboard: publicDashboard(dashboard), widgets };
}

/** Render the embed behind a verified session. */
export async function viewEmbed({ sessionToken, origin, parentOrigin, filters }) {
  const row = await verifySession({ sessionToken, origin, parentOrigin });
  const view = await runView(row, filters);
  return { ...view, theme: row.theme ?? 'auto' };
}

/** Kept for callers that already resolved a row-like scope. */
export async function executeEmbed({ tenantId, dashboardId, widgetId } = {}) {
  return runView({ tenantId, dashboardId, widgetId }, null);
}

/* ------------------------------- share links ------------------------------ */

/** Create a public share link (random secret returned once). */
export async function createShareLink({ tenantId, dashboardId, name = '', ttlSec, actorId = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  await loadPublishedDashboard({ tenantId, dashboardId });
  const ttl = ttlSec ?? 7 * 24 * 60 * 60;
  validateTtl(ttl, env.security.embed.shareMaxTtlSec);
  const secret = generateToken(32);
  const doc = await embedTokenRepository.create({
    tenantId: String(tenantId), dashboardId, name, kind: 'share', tokenHash: sha256(secret),
    status: 'active', expiresAt: new Date(Date.now() + ttl * 1000), createdBy: actorId,
  });
  await securityEvent('EMBED_TOKEN_CREATED', {
    tenantId: String(tenantId),
    resource: { type: 'embed_token', id: String(doc._id) },
    metadata: { tokenId: String(doc._id), kind: 'share', dashboardId: String(dashboardId), expiresAt: doc.expiresAt },
  });
  return { token: redact(doc), secret };
}

/**
 * Allow-listed public share payload: dashboard name/description/layout and
 * per-widget name, type and result rows/columns. No ids, no queries.
 */
export function sharePayload(view) {
  return {
    dashboard: { name: view.dashboard.name, description: view.dashboard.description ?? '' },
    widgets: view.widgets.map((w, i) => ({
      key: `w${i + 1}`,
      name: w.name ?? '',
      type: w.type ?? 'unknown',
      status: w.status,
      ...(w.status === 'ok'
        ? { result: { columns: w.result?.columns ?? [], rows: w.result?.rows ?? [], total: w.result?.total ?? null } }
        : {}),
    })),
  };
}

/** Render a public share link. */
export async function viewShare({ secret }) {
  if (!secret || typeof secret !== 'string' || secret.length < 16 || secret.length > 256) throw err.share();
  const row = await embedTokenRepository.findByTokenHash(sha256(secret));
  if (!(await liveRow(row, { kind: 'share' }))) throw err.share();
  embedTokenRepository.update(row._id, { lastUsedAt: new Date() }).catch(() => {});
  return sharePayload(await runView(row, null));
}

export default {
  normalizeOrigin,
  effectiveOrigin,
  isOriginKnown,
  getConfig,
  updateConfig,
  createEmbedToken,
  listEmbedTokens,
  getEmbedToken,
  revokeEmbedToken,
  resolveToken,
  exchangeSession,
  verifySession,
  combineFilters,
  viewEmbed,
  executeEmbed,
  createShareLink,
  sharePayload,
  viewShare,
  _meta: { statuses: EMBED_TOKEN_STATUSES },
};
