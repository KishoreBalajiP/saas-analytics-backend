/**
 * S3 (S3-compatible) storage driver.
 *
 * WHY IT EXISTS
 *   Production deployments (Render, Railway, AWS ECS) store uploads and
 *   exports in object storage - AWS S3 or S3-compatible services (MinIO,
 *   DigitalOcean Spaces, Cloudflare R2). This driver abstracts that so
 *   business logic never talks to the AWS SDK directly.
 *
 * RESPONSIBILITY
 *   Return a driver implementing the same `StorageDriver` surface as every
 *   other provider. Built on `@aws-sdk/client-s3`.
 *
 * DRIVER SURFACE (identical to localStorage.js - see its JSDoc):
 *   put, get, delete, exists, list, createWriteStream, createReadStream,
 *   presignedUrl, close, putFile
 *
 * CONFIG:
 *   { provider: 's3', bucket, region, endpoint, accessKeyId, secretAccessKey,
 *     forcePathStyle }
 *   Credentials come from env/config - never from code or logs.
 *
 * HOW TO EXTEND
 *   The driver is provider-pluggable. Switching regions, credentials, or
 *   even S3-compatible services (MinIO, R2) is a configuration change.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Transform } from 'node:stream';
import { createReadStream as createFileReadStream } from 'node:fs';
import { stat as statFile } from 'node:fs/promises';

const DEFAULT_REGION = 'us-east-1';

/**
 * Create the S3 storage driver.
 *
 * @param {Object} config - { bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle }.
 * @returns {Object} StorageDriver.
 */
export function createS3Storage(config = {}) {
  if (!config.bucket) {
    throw new Error('S3 storage requires `bucket` to be configured');
  }
  const region = typeof config.region === 'string' ? config.region : DEFAULT_REGION;
  const endpoint = typeof config.endpoint === 'string' && config.endpoint.length > 0 ? config.endpoint : undefined;
  const forcePathStyle = config.forcePathStyle === true;

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined, // fall back to the AWS SDK default provider chain
  });

  return Object.freeze({
    provider: 's3',
    config: Object.freeze({ bucket: config.bucket, region, endpoint, forcePathStyle }),

    async put(key, data, options = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('storage.put requires a non-empty key');
      }
      const Body = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, options.encoding || 'utf8')
          : Buffer.from(JSON.stringify(data));
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body,
        ContentType: options.contentType,
        Metadata: options.metadata,
      });
      await client.send(command);
      return { key, size: Body.length };
    },

    async get(key) {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      const response = await client.send(command);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks);
    },

    async delete(key) {
      const command = new DeleteObjectCommand({ Bucket: config.bucket, Key: key });
      await client.send(command);
    },

    async exists(key) {
      try {
        const command = new HeadObjectCommand({ Bucket: config.bucket, Key: key });
        await client.send(command);
        return true;
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
          return false;
        }
        throw err;
      }
    },

    async list(prefix = '', options = {}) {
      const out = [];
      let continuationToken;
      const limit = Number.isInteger(options.limit) ? options.limit : 1000;
      do {
        const command = new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: Math.min(limit - out.length, 1000),
        });
        const response = await client.send(command);
        for (const obj of response.Contents ?? []) {
          if (obj.Key) out.push(obj.Key);
          if (out.length >= limit) break;
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken && out.length < limit);
      return out;
    },

    /**
     * Writable stream for a key, uploaded with a managed (multipart when
     * large) upload. `stream.completed` resolves with `{ key, size }` once
     * the object is stored (after `end()`), and rejects when the upload
     * fails; destroying the stream aborts the upload.
     */
    async createWriteStream(key, options = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('storage.createWriteStream requires a non-empty key');
      }
      let size = 0;
      // Counts bytes on their way to the upload (a 'data' listener would
      // switch the body into flowing mode under the uploader).
      const body = new Transform({
        transform(chunk, _enc, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          Metadata: options.metadata,
        },
      });
      body.completed = upload.done().then(() => ({ key, size }));
      body.once('error', () => { upload.abort().catch(() => {}); });
      // A failed upload is reported through `completed`; never unhandled.
      body.completed.catch(() => {});
      return body;
    },

    /** Readable stream of a stored object. */
    async createReadStream(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return response.Body;
    },

    // backups: streamed upload of a local file (multipart for large files).
    async putFile(key, filePath, options = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('storage.putFile requires a non-empty key');
      }
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: createFileReadStream(filePath),
          ContentType: options.contentType,
          Metadata: options.metadata,
        },
      });
      await upload.done();
      const { size } = await statFile(filePath);
      return { key, size };
    },


    async presignedUrl(key, options = {}) {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: options.contentDisposition,
      });
      const ttlSec = Number.isInteger(options.ttlSec) ? options.ttlSec : 300;
      return getSignedUrl(client, command, { expiresIn: ttlSec });
    },

    async close() {
      client.destroy();
    },
  });
}

export default createS3Storage;
