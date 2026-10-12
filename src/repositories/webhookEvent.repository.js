import WebhookEvent from '../models/WebhookEvent.js';

export async function recordEvent({ provider, eventId, eventType, raw, tenantId, subscriptionId }) {
  if (!provider || !eventId || !eventType) return null;
  try {
    const doc = await WebhookEvent.findOneAndUpdate(
      { provider, eventId },
      {
        $setOnInsert: { provider, eventId, eventType, raw: raw ?? null, tenantId: tenantId ?? null, subscriptionId: subscriptionId ?? null },
      },
      { upsert: true, new: true },
    );
    return doc;
  } catch (err) {
    return null;
  }
}

export async function markProcessed({ provider, eventId, error = null }) {
  const update = { processed: !error, error: error || undefined, processedAt: !error ? new Date() : undefined };
  return WebhookEvent.findOneAndUpdate({ provider, eventId }, { $set: update }, { new: true });
}

export default { recordEvent, markProcessed };
