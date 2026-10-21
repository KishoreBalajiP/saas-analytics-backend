/**
 * EmailTemplate Repository (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Data access for platform-admin overrides of the built-in transactional
 *   email templates (`models/EmailTemplate.js`). No business logic: the
 *   service validates content and decides which row is used for a send.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Platform-global (no tenantId).
 *   - `updateIfVersion` is the only write path after creation, so every
 *     change bumps `version` exactly once.
 */

import { EmailTemplate } from '../models/EmailTemplate.js';

/** The row for (key, locale), whatever its status, or null. */
export const findByKeyLocale = (key, locale) => EmailTemplate.findOne({ key, locale }).lean();

/** The ACTIVE override for (key, locale), or null. */
export const findActive = (key, locale) => EmailTemplate.findOne({ key, locale, status: 'active' }).lean();

/** Every row for a locale. */
export const listByLocale = (locale) => EmailTemplate.find({ locale }).lean();

/**
 * Create the (key, locale) row when absent; never overwrites. Returns the
 * row (created or existing).
 */
export const insertIfAbsent = async (data) => {
  const existing = await findByKeyLocale(data.key, data.locale);
  if (existing) return existing;
  try {
    const doc = new EmailTemplate(data);
    await doc.save();
    return doc.toObject();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const concurrent = await findByKeyLocale(data.key, data.locale);
    if (!concurrent) throw error;
    return concurrent;
  }
};

/**
 * Versioned write: apply `set` only when the row is still at
 * `expectedVersion`; bumps `version`. Returns the updated doc or null.
 */
export const updateIfVersion = (id, expectedVersion, set) =>
  EmailTemplate.findOneAndUpdate(
    { _id: id, version: expectedVersion === 0 ? { $in: [0, null] } : expectedVersion },
    { $set: set, $inc: { version: 1 } },
    { new: true, runValidators: true, lean: true },
  );

export default { findByKeyLocale, findActive, listByLocale, insertIfAbsent, updateIfVersion };
