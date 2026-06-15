import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';
import { HttpError } from '../middleware/error.middleware';

// Cloudflare R2 (private bucket) via the S3-compatible API. Uploads use a
// short-lived pre-signed PUT; viewing uses a 1h pre-signed GET (SRS §13). When
// R2 isn't configured the upload flow is a documented no-op (callers check
// isR2Configured()), so the system still works without a bucket.

export function isR2Configured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
  );
}

const PUT_TTL_SECONDS = 15 * 60; // window to complete the upload
const GET_TTL_SECONDS = 60 * 60; // 1h view link (SRS §13)

let client: S3Client | null = null;
function r2(): S3Client {
  if (!isR2Configured()) {
    throw new HttpError(503, 'R2_NOT_CONFIGURED', 'File storage is not configured');
  }
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

/** Pre-signed PUT URL the client uploads the object bytes to directly. */
export function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, ContentType: contentType }),
    { expiresIn: PUT_TTL_SECONDS }
  );
}

/** Pre-signed GET URL for viewing a private object (e.g. on the admin panel). */
export function presignDownload(key: string): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }), {
    expiresIn: GET_TTL_SECONDS,
  });
}
