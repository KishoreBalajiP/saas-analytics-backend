/** AI repository (ai-ask): questions and consent, always tenant-filtered. */
import { AiQuestion } from '../models/AiQuestion.js';
import { AiConsent } from '../models/AiConsent.js';

export async function createQuestion(data) {
  return (await AiQuestion.create(data)).toObject();
}
export function findQuestion({ tenantId, id }) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(id))) return null;
  return AiQuestion.findOne({ _id: id, tenantId: String(tenantId) }).lean();
}
export function setFeedback({ tenantId, id, feedback }) {
  return AiQuestion.findOneAndUpdate({ _id: id, tenantId: String(tenantId) }, { $set: { feedback } }, { new: true, lean: true });
}
export function getConsent(tenantId) {
  return AiConsent.findOne({ tenantId: String(tenantId) }).lean();
}
export function setConsent({ tenantId, granted, by }) {
  const now = new Date();
  const set = granted
    ? { granted: true, grantedBy: by, grantedAt: now, revokedAt: null, revokedBy: null }
    : { granted: false, revokedBy: by, revokedAt: now };
  return AiConsent.findOneAndUpdate({ tenantId: String(tenantId) }, { $set: set }, { upsert: true, new: true, lean: true });
}
export default { createQuestion, findQuestion, setFeedback, getConsent, setConsent };
