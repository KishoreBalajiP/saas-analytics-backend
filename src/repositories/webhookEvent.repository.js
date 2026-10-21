/**
 * WebhookEvent repository (Phase 6.1; billing roadmap 3.1).
 *
 * PURPOSE
 *   Data access for stored payment-provider webhook events: the dedupe
 *   insert, the processing claim, and the retry bookkeeping. No business
 *   logic (see `services/billingWebhook.service.js`).
 */

import WebhookEvent from '../models/WebhookEvent.js';

/**
 * Insert the event once. A redelivery of the same `(provider, eventId)`
 * returns the stored row with `duplicate: true` (the unique index is the
 * guard, so concurrent deliveries cannot both insert).
 *
 * @returns {Promise<{ event: Object|null, duplicate: boolean }>}
 */
export async function insertOnce({ provider, eventId, eventType, raw, providerCreatedAt = null, now = new Date() }) {
  if (!provider || !eventId || !eventType) return { event: null, duplicate: false };
  try {
    const created = await WebhookEvent.create({
      provider,
      eventId,
      eventType,
      raw: raw ?? null,
      status: 'received',
      processed: false,
      attempts: 0,
      nextAttemptAt: now,
      providerCreatedAt,
    });
    return { event: created.toObject(), duplicate: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await WebhookEvent.findOneAndUpdate(
      { provider, eventId },
      { $inc: { deliveries: 1 } },
      { new: true, lean: true },
    );
    return { event: existing, duplicate: true };
  }
}

/** Legacy helper kept for older callers: insert-or-return. */
export async function recordEvent({ provider, eventId, eventType, raw }) {
  const { event } = await insertOnce({ provider, eventId, eventType, raw });
  return event;
}

/** Take the processing lease on a due, unfinished event. */
export async function claim(id, { now = new Date(), leaseMs = 60000 } = {}) {
  return WebhookEvent.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: 'received', nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    },
    { $set: { status: 'processing', leaseUntil: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } },
    { new: true, lean: true },
  );
}

/** Finish an event (`processed` or `ignored`). */
export async function finish(id, { status = 'processed', outcome = null, error = null, tenantId = null, now = new Date() } = {}) {
  return WebhookEvent.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status,
        outcome,
        processed: true,
        processedAt: now,
        leaseUntil: null,
        error: error ?? undefined,
        ...(tenantId ? { tenantId } : {}),
      },
    },
    { new: true, lean: true },
  );
}

/** Put an event back for a retry at `nextAttemptAt`, or give it up. */
export async function retryLater(id, { nextAttemptAt, error = null, giveUp = false } = {}) {
  return WebhookEvent.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status: giveUp ? 'failed' : 'received',
        nextAttemptAt,
        leaseUntil: null,
        error: error ? String(error).slice(0, 300) : undefined,
      },
    },
    { new: true, lean: true },
  );
}

/** Due events for the retry sweep (oldest first). */
export async function listDue({ now = new Date(), limit = 50 } = {}) {
  return WebhookEvent.find({
    $or: [
      { status: 'received', nextAttemptAt: { $lte: now } },
      { status: 'processing', leaseUntil: { $lte: now } },
    ],
  })
    .sort({ nextAttemptAt: 1 })
    .limit(Math.min(Math.max(1, limit), 200))
    .lean();
}

/** Legacy helper: mark an event processed / failed by its key. */
export async function markProcessed({ provider, eventId, error = null }) {
  const update = { processed: !error, error: error || undefined, processedAt: !error ? new Date() : undefined };
  return WebhookEvent.findOneAndUpdate({ provider, eventId }, { $set: update }, { new: true });
}

export default { insertOnce, recordEvent, claim, finish, retryLater, listDue, markProcessed };
