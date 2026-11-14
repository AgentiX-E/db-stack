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
 * @module @agentix-e/db-operations-backup/impl
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IStorageBackend } from '../interfaces/index.js';

// ── Constants ────────────────────────────────────────────────────

/** Default multipart upload threshold: 10 MB. */
const DEFAULT_MULTIPART_THRESHOLD = 10 * 1024 * 1024;

/** Default part size for multipart upload: 5 MB. */
const DEFAULT_PART_SIZE = 5 / 1024 * 1024;

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

function retry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  return fn().catch((err) => {
    if (attempt >= MAX_RETRIES) throw err;
    const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
    return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
      retry(fn, attempt + 1),
    );
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

  private readonly client: S3Client;
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

    const s3Config: S3ClientConfig = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId ?? '',
        secretAccessKey: config.secretAccessKey ?? '',
      },
      requestHandler: {
        requestTimeout: config.requestTimeoutMs ?? 30_000,
        connectionTimeout: config.connectTimeoutMs ?? 5_000,
      },
    };

    if (config.endpoint) {
      s3Config.endpoint = config.endpoint;
    }
    if (config.forcePathStyle) {
      s3Config.forcePathStyle = true;
    }

    this.client = new S3Client(s3Config);
  }

  private getKey(sourceKey: string): string {
    return this.keyPrefix + sourceKey;
  }

  private getSseInput():
    | { ServerSideEncryption: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string }
    | { SSECustomerAlgorithm: 'AES256'; SSECustomerKey: string; SSECustomerKeyMD5?: string }
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
    const body = await readFile(sourcePath);
    const checksum = sha256Hex(body);
    const sseInput = this.getSseInput();

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ChecksumSHA256: checksum,
      ContentLength: body.length,
      ...sseInput,
    });

    await this.client.send(command);
  }

  private async multipartUpload(sourcePath: string, key: string): Promise<void> {
    const body = createReadStream(sourcePath);
    const sseInput = this.getSseInput();

    const upload = new Upload({
      client: this.client,
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
    const key = this.getKey(sourceKey);
    const sseInput = this.getSseInput();

    await retry(async () => {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...sseInput,
      });

      const response = await this.client.send(command);

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
    const results: Array<{ key: string; size: number; lastModified: string }> = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.getKey(prefix),
        ContinuationToken: continuationToken,
      });

      const response = await retry(() => this.client.send(command));

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (!obj.Key) continue;
          // Strip the keyPrefix from returned keys
          const relativeKey = this.keyPrefix
            ? obj.Key.slice(this.keyPrefix.length)
            : obj.Key;
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
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.getKey(key),
    });

    await retry(() => this.client.send(command));
  }

  /** @inheritdoc */
  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: '.health-check',
      });
      await this.client.send(command);
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
    let total = 0;
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.keyPrefix,
        ContinuationToken: continuationToken,
      });

      const response = await retry(() => this.client.send(command));

      if (response.Contents) {
        for (const obj of response.Contents) {
          total += obj.Size ?? 0;
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return total;
  }

  /** Close the S3 client (releases HTTP connections). */
  destroy(): void {
    if (!this.closed) {
      this.client.destroy();
      this.closed = true;
    }
  }
}
