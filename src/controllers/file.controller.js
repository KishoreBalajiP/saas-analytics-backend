/**
 * File Controller (roadmap 1.5).
 *
 * PURPOSE
 *   Serves a stored artefact (report run, analytics export) to the holder
 *   of a short-lived signed download URL minted by
 *   `storage.service.signedDownloadUrl` when storage is local. With S3 the
 *   signed URL points at S3 directly and this endpoint is not used.
 *
 * SECURITY
 *   The token is the credential: an HMAC-signed grant for exactly one
 *   storage key, a file name and a content type, with an expiry. Requests
 *   are authorised (tenant + permission) when the URL is minted. A token
 *   that is malformed, forged or expired answers 404 DOWNLOAD_LINK_INVALID
 *   without revealing which. Responses are never cached.
 */

import { pipeline } from 'node:stream/promises';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as storageService from '../services/storage.service.js';

function invalidLink() {
  return new ApiError(404, 'This download link is invalid or has expired. Request a new download.', { code: 'DOWNLOAD_LINK_INVALID' });
}

/** GET /api/v1/files/:token - stream the granted object as an attachment. */
export const downloadFile = asyncHandler(async (req, res) => {
  const grant = storageService.verifyDownloadToken(req.params.token);
  if (!grant) throw invalidLink();
  let stream;
  try {
    stream = await storageService.createReadStream(grant.key);
  } catch {
    // The artefact was removed (retention) after the link was minted.
    throw invalidLink();
  }
  res.status(200);
  res.setHeader('Content-Type', grant.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', storageService.attachmentDisposition(grant.fileName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    await pipeline(stream, res);
  } catch (err) {
    // The client went away mid-download; nothing left to send.
    logger.debug({ err: { message: err?.message } }, 'file download interrupted');
  }
});

export default { downloadFile };
