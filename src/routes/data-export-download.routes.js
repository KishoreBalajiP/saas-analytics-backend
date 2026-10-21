/**
 * /api/v1/data-exports routes (roadmap 2.9 - signed export downloads).
 *
 * WHY IT EXISTS
 *   With local storage there is no object store to presign against, so the
 *   API itself serves export archives behind a signed link. The link is
 *   minted only by the authenticated, permission-checked `download-url`
 *   endpoints, carries an HMAC over (export, tenant, expiry, issuer), lives
 *   minutes and never outlives the archive. With S3 storage the download
 *   URL is an S3 presigned URL instead and this route is unused.
 *
 * ENDPOINTS
 *   - GET /download/:token   stream the archive (public; the token is the credential)
 */

import { Router } from 'express';
import tenantExportController from '../controllers/tenantExport.controller.js';

const router = Router();

router.get( // ci:routes-exempt: signed, expiring download link minted by an authenticated + permission-checked endpoint
  '/download/:token',
  tenantExportController.downloadExport,
);

export default router;
