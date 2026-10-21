/**
 * Security detection rule catalogue (roadmap 2.6, document 11 section 4).
 *
 * Rules are VERSIONED CODE. Each rule declares:
 *   id, version      stable id; bump `version` whenever the logic or a
 *                    default threshold changes (alerts record both)
 *   title, description, source, severity
 *   defaults, params thresholds and their types (overridable per rule via
 *                    SECURITY_DETECTION_RULES_JSON or the platform setting
 *                    `security.detection.rules`; see ../params.js)
 *   lagMs?           extra settle time for buffered sources (signals)
 *   evaluate(ctx)    pure read of the event sources for (ctx.from, ctx.to]
 *                    returning detections; never writes
 *
 * HOW TO ADD A RULE
 *   1. Write it next to its siblings (one file per event source family).
 *   2. Add it to RULES below.
 *   3. Add a synthetic replay test (fires at the threshold, not below,
 *      dedupes, does not reprocess) to tests/security-detection/.
 */

import authenticationRules from './authentication.js';
import privilegeRules from './privilege.js';
import supportRules from './support.js';
import apiKeyRules from './apiKeys.js';
import trafficRules from './traffic.js';
import exportRules from './exports.js';
import connectorRules from './connectors.js';
import resourceRules from './resources.js';

export const RULES = Object.freeze([
  ...authenticationRules,
  ...privilegeRules,
  ...supportRules,
  ...apiKeyRules,
  ...trafficRules,
  ...exportRules,
  ...connectorRules,
  ...resourceRules,
]);

/** Rule by id (undefined when unknown). */
export function getRule(id) {
  return RULES.find((rule) => rule.id === id);
}

export default RULES;
