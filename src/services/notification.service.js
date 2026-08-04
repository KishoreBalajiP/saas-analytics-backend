/**
 * Notification Service (architecture placeholder).
 *
 * PURPOSE
 *   Single entry for in-app / email / push / webhook delivery. The
 *   service resolves template, applies user preferences, and hands off
 *   to the right transport.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - dispatch({ actorId, actorType, channel, templateKey, data })
 *   - listInbox, markRead, markAllRead, removeInbox
 *   - getPreferences(actorId), setPreferences(actorId, prefs)
 *   - adminBroadcast({ tenantScope?, templateKey, data })
 *
 * CODING GUIDELINES
 *   - WebSocket emit happens inside `dispatch` for in-app channel.
 *   - Failed deliveries retry with exponential backoff.
 *   - Per-actor preference is the default-deny rule outside transactional.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const dispatch = notImplementedStub('notification.service', 'dispatch');
export const listInbox = notImplementedStub('notification.service', 'listInbox');
export const markRead = notImplementedStub('notification.service', 'markRead');
export const markAllRead = notImplementedStub('notification.service', 'markAllRead');
export const removeInbox = notImplementedStub('notification.service', 'removeInbox');
export const getUnreadCount = notImplementedStub('notification.service', 'getUnreadCount');
export const getPreferences = notImplementedStub('notification.service', 'getPreferences');
export const setPreferences = notImplementedStub('notification.service', 'setPreferences');
export const adminBroadcast = notImplementedStub('notification.service', 'adminBroadcast');

export default {
  dispatch, listInbox, markRead, markAllRead, removeInbox,
  getUnreadCount, getPreferences, setPreferences, adminBroadcast,
  _meta: { retryBackoff: 'exponential' },
};
