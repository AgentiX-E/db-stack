/**
 * S3StorageBackend — Production-grade S3-compatible storage backend.
 *
 * Features:
 *   - AWS S3 / S3-compatible (MinIO, Ceph, DigitalOcean Spaces) support
 *   - Server-side encryption (SSE-S3, SSE-KMS, SSE-C)
 *   - Multipart upload for large files (>10MB threshold)
 *   - Checksum verification (SHA256)
 *   - Configurable endpoint, region, and auth
 *   - Retry with exponential backoff
 *   - Automatic detection: single-part or multipart based on file size
 *
 * @module @agentix-e/db-node/backup/impl
 */

import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IStorageBackend } from '../interfaces/index.js';

// ── The SDK this backend needs and does not install ──────────────

/**
 * `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are optional peer
 * dependencies: a deployment that backs up to a filesystem, or to an object
 * store of its own, should not carry the AWS SDK to reach this class, and the
 * package that publishes this backend publishes twelve more.
 *
 * A static import would have made the peers mandatory in practice regardless of
 * what the manifest says, because the umbrella entry point re-exports the module
 * — `import '@agentix-e/db-node'` would have failed for every
 * consumer without the SDK installed. The import is therefore deferred to first
 * use, and its absence is a refusal that names the fix rather than a
 * `MODULE_NOT_FOUND` from a bundler.
 */
const MISSING_SDK =
  'S3StorageBackend needs the optional peer dependencies @aws-sdk/client-s3 and ' +
  '@aws-sdk/lib-storage. Install both where the backup target runs: ' +
  'npm install @aws-sdk/client-s3 @aws-sdk/lib-storage';

type AwsSdk = {
  readonly client: typeof import('@aws-sdk/client-s3');
  readonly upload: typeof import('@aws-sdk/lib-storage');
};

let loading: Promise<AwsSdk> | undefined;

/**
 * Load the SDK once per process.
 *
 * A failed load is not cached: the next attempt is allowed to follow the
 * `npm install` that fixes it, and a process that runs for a month should not
 * have to be restarted to pick up a peer dependency.
 */
function loadSdk(): Promise<AwsSdk> {
  if (!loading) {
    loading = (async () => {
      try {
        const [client, upload] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/lib-storage')]);
        return { client, upload };
      } catch (error) {
        loading = undefined;
        throw new Error(MISSING_SDK, { cause: error });
      }
    })();
  }
  return loading;
}

// ── Constants ────────────────────────────────────────────────────

/** Default multipart upload threshold: 10 MB. */
const DEFAULT_MULTIPART_THRESHOLD = 10 * 1024 * 1024;

/** Default part size for multipart upload: 5 MB (S3's minimum part size). */
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

/** Maximum retries for transient errors. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const RETRY_BASE_MS = 500;

// ── Config ───────────────────────────────────────────────────────

/** Configuration for S3StorageBackend. */
export interface S3StorageBackendConfig {
  /** S3 bucket name. */
  bucket: string;
  /** S3 endpoint (for S3-compatible stores like MinIO). */
  endpoint?: string;
  /** AWS region. */
  region: string;
  /** Access key ID. */
  accessKeyId?: string;
  /** Secret access key. */
  secretAccessKey?: string;
  /** Prefix for all keys (e.g., "backups/production/"). */
  keyPrefix?: string;
  /** Multipart upload threshold in bytes (default: 10 MB). */
  multipartThreshold?: number;
  /** Part size in bytes (default: 5 MB). */
  partSize?: number;
  /** Server-side encryption mode. */
  sse?: 's3' | 'kms' | 'c';
  /** SSE-KMS key ID (required when sse='kms'). */
  sseKmsKeyId?: string;
  /** SSE-C key (base64-encoded, required when sse='c'). */
  sseCustomerKey?: string;
  /** Force path-style addressing (required for MinIO). */
  forcePathStyle?: boolean;
  /** Connect timeout in milliseconds. */
  connectTimeoutMs?: number;
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Whether a failed request is worth repeating.
 *
 * Server-side faults (5xx) and throttling (429) are transient: the same request
 * can succeed on a later attempt. A 4xx answer is the bucket rejecting this
 * specific request — bad credentials, a missing key, a malformed key — so
 * retrying it only multiplies the load and delays the error the caller needs.
 * Errors without an HTTP status come from the transport (DNS, reset, timeout)
 * or from a local failure, and stay retryable.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  if (typeof status !== 'number') return true;
  return status >= 500 || status === 429;
}

function retry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  return fn().catch((err) => {
    if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
    const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
    return new Promise((resolve) => setTimeout(resolve, delay)).then(() => retry(fn, attempt + 1));
  });
}

// ══════════════════════════════════════════════════════════════════
//  S3StorageBackend
// ══════════════════════════════════════════════════════════════════

/**
 * Production-grade S3-compatible storage backend implementing IStorageBackend.
 *
 * Supports:
 *   - AWS S3 and all S3-compatible stores (MinIO, Ceph, DigitalOcean Spaces)
 *   - Server-side encryption (SSE-S3, SSE-KMS, SSE-C)
 *   - Multipart upload for large objects
 *   - SHA256 checksum verification
 *   - Exponential backoff retry
 *   - Path-style or virtual-hosted addressing
 */
export class S3StorageBackend implements IStorageBackend {
  readonly name = 's3';

  private client?: S3Client;
  private sdk?: AwsSdk;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly multipartThreshold: number;
  private readonly partSize: number;
  private readonly sse?: 's3' | 'kms' | 'c';
  private readonly sseKmsKeyId?: string;
  private readonly sseCustomerKey?: string;
  private closed = false;

  constructor(private readonly config: S3StorageBackendConfig) {
    this.bucket = config.bucket;
    this.keyPrefix = config.keyPrefix ?? '';
    this.multipartThreshold = config.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
    this.partSize = config.partSize ?? DEFAULT_PART_SIZE;
    this.sse = config.sse;
    this.sseKmsKeyId = config.sseKmsKeyId;
    this.sseCustomerKey = config.sseCustomerKey;
  }

  /**
   * The SDK and a client built from the configuration, on first use.
   *
   * Both are resolved together because a client without the SDK cannot exist,
   * and the retry in `loadSdk` has to see the same call site: a constructor that
   * resolved the peer eagerly would turn "this deployment does not use S3" into
   * "this build cannot import the operations package".
   */
  private async connection(): Promise<{ sdk: AwsSdk; client: S3Client }> {
    if (!this.sdk) {
      this.sdk = await loadSdk();
    }
    if (!this.client) {
      const s3Config: S3ClientConfig = {
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId ?? '',
          secretAccessKey: this.config.secretAccessKey ?? '',
        },
        requestHandler: {
          requestTimeout: this.config.requestTimeoutMs ?? 30_000,
          connectionTimeout: this.config.connectTimeoutMs ?? 5_000,
        },
      };

      if (this.config.endpoint) {
        s3Config.endpoint = this.config.endpoint;
      }
      if (this.config.forcePathStyle) {
        s3Config.forcePathStyle = true;
      }

      this.client = new this.sdk.client.S3Client(s3Config);
    }
    return { sdk: this.sdk, client: this.client };
  }

  private getKey(sourceKey: string): string {
    return this.keyPrefix + sourceKey;
  }

  private getSseInput():
    | { ServerSideEncryption: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string }
    | {
        SSECustomerAlgorithm: 'AES256';
        SSECustomerKey: string;
        SSECustomerKeyMD5?: string;
      }
    | undefined {
    if (this.sse === 's3') {
      return { ServerSideEncryption: 'AES256' };
    }
    if (this.sse === 'kms') {
      return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.sseKmsKeyId };
    }
    if (this.sse === 'c' && this.sseCustomerKey) {
      return {
        SSECustomerAlgorithm: 'AES256',
        SSECustomerKey: this.sseCustomerKey,
      };
    }
    return undefined;
  }

  /** @inheritdoc */
  async upload(sourcePath: string, destKey: string): Promise<void> {
    const key = this.getKey(destKey);
    const stats = statSync(sourcePath);

    await retry(async () => {
      if (stats.size >= this.multipartThreshold) {
        await this.multipartUpload(sourcePath, key);
      } else {
        await this.singleUpload(sourcePath, key);
      }
    });
  }

  private async singleUpload(sourcePath: string, key: string): Promise<void> {
    const { sdk, client } = await this.connection();
    const body = await readFile(sourcePath);
    const checksum = sha256Hex(body);
    const sseInput = this.getSseInput();

    const command = new sdk.client.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ChecksumSHA256: checksum,
      ContentLength: body.length,
      ...sseInput,
    });

    await client.send(command);
  }

  private async multipartUpload(sourcePath: string, key: string): Promise<void> {
    const { sdk, client } = await this.connection();
    const body = createReadStream(sourcePath);
    const sseInput = this.getSseInput();

    const upload = new sdk.upload.Upload({
      client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...sseInput,
      },
      partSize: this.partSize,
      queueSize: 4, // concurrent parts
    });

    await upload.done();
  }

  /** @inheritdoc */
  async download(sourceKey: string, destPath: string): Promise<void> {
    const { sdk, client } = await this.connection();
    const key = this.getKey(sourceKey);
    const sseInput = this.getSseInput();

    await retry(async () => {
      const command = new sdk.client.GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...sseInput,
      });

      const response = await client.send(command);

      if (!response.Body) {
        throw new Error(`Empty response body for key: ${key}`);
      }

      // Response.Body is a ReadableStream (in newer SDK) or Readable
      const body = await response.Body.transformToByteArray();
      await writeFile(destPath, Buffer.from(body));
    });
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const { sdk, client } = await this.connection();
    const results: Array<{ key: string; size: number; lastModified: string }> = [];
    let continuationToken: string | undefined;

    do {
      const command = new sdk.client.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.getKey(prefix),
        ContinuationToken: continuationToken,
      });

      const response = await retry(() => client.send(command));

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;
          // Strip the keyPrefix from returned keys
          const relativeKey = this.keyPrefix ? obj.Key.slice(this.keyPrefix.length) : obj.Key;
          results.push({
            key: relativeKey,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? '',
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return results;
  }

  /** @inheritdoc */
  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.connection();
    const command = new sdk.client.DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.getKey(key),
    });

    await retry(() => client.send(command));
  }

  /** @inheritdoc */
  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      const { sdk, client } = await this.connection();
      const command = new sdk.client.HeadObjectCommand({
        Bucket: this.bucket,
        Key: '.health-check',
      });
      await client.send(command);
      return { ok: true };
    } catch (err: unknown) {
      // If the object doesn't exist, the bucket is still accessible
      if (err instanceof Error && err.name === 'NotFound') {
        return { ok: true };
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** @inheritdoc */
  async getUsageBytes(): Promise<number> {
    const { sdk, client } = await this.connection();
    let total = 0;
    let continuationToken: string | undefined;

    do {
      const command = new sdk.client.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.keyPrefix,
        ContinuationToken: continuationToken,
      });

      const response = await retry(() => client.send(command));

      if (response.Contents) {
        for (const obj of response.Contents) {
          total += obj.Size ?? 0;
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return total;
  }

  /**
   * Close the S3 client (releases HTTP connections).
   *
   * A backend that never reached the network has no client and nothing to
   * release; the flag still flips, so `destroy()` twice is one call.
   */
  destroy(): void {
    if (!this.closed) {
      this.client?.destroy();
      this.closed = true;
    }
  }
}
