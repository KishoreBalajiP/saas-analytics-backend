/**
 * Delivery controller (delivery, roadmap 3.4).
 *
 * Thin HTTP layer over `services/delivery`: destinations, delivery history,
 * manual retry and the public unsubscribe endpoint. Destination URLs and
 * secrets are never returned (the webhook signing secret only once, at creation).
 */

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import deliveryService from '../services/delivery/index.js';
import { getTenantId } from '../middleware/tenant.middleware.js';

const tenantOf = (req) => String(getTenantId(req));
const actorOf = (req) => req.user?.id ?? null;

export const listDestinations = asyncHandler(async (req, res) => ApiResponse.ok(res, await deliveryService.listDestinations({ tenantId: tenantOf(req) }), 'Destinations'));

export const createDestination = asyncHandler(async (req, res) => {
  const { type, name, url } = req.body || {};
  const row = await deliveryService.createDestination({ tenantId: tenantOf(req), type, name, url, actorId: actorOf(req) });
  return ApiResponse.created(res, row, 'Destination created');
});

export const removeDestination = asyncHandler(async (req, res) => ApiResponse.ok(res, await deliveryService.removeDestination({ tenantId: tenantOf(req), destinationId: req.params.id, actorId: actorOf(req) }), 'Destination removed'));

export const listDeliveries = asyncHandler(async (req, res) => {
  const { sourceId, status, kind, page, limit } = req.query || {};
  const out = await deliveryService.listDeliveries({ tenantId: tenantOf(req), sourceId, status, kind, page, limit });
  return ApiResponse.ok(res, out.docs, 'Deliveries', { total: out.total, page: out.page, limit: out.limit });
});

export const retryDelivery = asyncHandler(async (req, res) => ApiResponse.ok(res, await deliveryService.retryDelivery({ tenantId: tenantOf(req), deliveryId: req.params.id }), 'Delivery retried'));

export const unsubscribe = asyncHandler(async (req, res) => ApiResponse.ok(res, await deliveryService.unsubscribe({ token: req.body?.token ?? req.query?.token }), 'Unsubscribed'));

export default { listDestinations, createDestination, removeDestination, listDeliveries, retryDelivery, unsubscribe };
