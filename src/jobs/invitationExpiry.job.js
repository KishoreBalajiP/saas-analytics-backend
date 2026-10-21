/**
 * Invitation expiry job (roadmap 2.10, ten.12).
 *
 * WHY IT EXISTS
 *   Invitations are kept as history instead of being removed by a TTL
 *   index. This sweep moves pending invitations past their `expiresAt` to
 *   `expired`, drops the invitee's provisional role grant and gives the
 *   `members` seat back.
 *
 * RESPONSIBILITY
 *   `tenantInvitationService.expireDue()`. Each row changes state through a
 *   conditional update, so overlapping runs and concurrent accept / resend
 *   / revoke calls are safe.
 *
 * HOW TO EXTEND
 *   `JOB_INVITATION_EXPIRY_CRON` / `JOB_INVITATION_EXPIRY_ENABLED`.
 */

import logger from '../utils/logger.js';
import env from '../config/env.js';
import tenantInvitationService from '../services/tenantInvitation.service.js';

export default {
  name: 'invitation-expiry',
  cronExpression: env.members.jobs.invitationExpiry.cron,
  enabled: env.members.jobs.invitationExpiry.enabled,

  async handler() {
    const summary = await tenantInvitationService.expireDue();
    if (summary.expired > 0) logger.info(summary, 'Invitation expiry job executed');
    return summary;
  },
};
