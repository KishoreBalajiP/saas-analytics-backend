/** Retention declarations for the ai-ask package (question log incl. question text). */
export const RETENTION = Object.freeze([
  { model: 'AiQuestion', field: 'createdAt', envKey: 'RETENTION_AI_QUESTIONS_DAYS', defaultDays: 90 },
]);
export default RETENTION;
