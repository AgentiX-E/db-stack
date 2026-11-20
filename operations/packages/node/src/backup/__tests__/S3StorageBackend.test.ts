/**
 * S3StorageBackend Tests — AC 50.x
 *
 * AC 50.1 — Single-part upload
 * AC 50.2 — Download
 * AC 50.3 — List with prefix
 * AC 50.4 — Delete
 * AC 50.5 — Health check (bucket accessible)
 * AC 50.6 — Retry on transient error
 * AC 50.7 — Key prefix
 * AC 50.8 — SSE-S3 encryption
 * AC 50.9 — Get usage bytes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S3StorageBackend, type S3StorageBackendConfig } from '../impl/S3StorageBackend.js';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Client } from '@aws-sdk/client-s3';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Result type the multipart uploader returns from done(). */
type UploadResult = Awaited<ReturnType<Upload['done']>>;

/**
 * The options and tuning Upload retains from its constructor. The SDK declares
 * them private, but they are the only place the multipart contract (bucket, key,
 * part size, queue depth, encryption) is observable before any request is sent.
 */
interface UploadInternals {
  params: {
    Bucket?: string;
    Key?: string;
    Body?: AsyncIterable<Uint8Array>;
    ServerSideEncryption?: string;
    SSEKMSKeyId?: string;
  };
  partSize: number;
  queueSize: number;
}

/** An S3 SDK error carrying the HTTP status the retry policy inspects. */
function s3Error(status: number, name: string, message: string): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

// ── Helper ───────────────────────────────────────────────────────

/** Create a temp file with given content. */
function createTempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 's3-test-'));
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/**
 * S3StorageBackend constructs its own S3 client and keeps it private, so
 * stubbing that client is the only way to exercise the request/response
 * translation. This is the single reflection edge in the file: a renamed member
 * throws at the stub site instead of leaving the assertions comparing nothing.
 */
function clientOf(backend: S3StorageBackend): S3Client {
  return Reflect.get(backend, 'client') as S3Client;
}

/** Whether the backend considers itself closed (private lifecycle flag). */
function isClosed(backend: S3StorageBackend): boolean {
  return Boolean(Reflect.get(backend, 'closed'));
}

/** Create S3StorageBackend with a mocked S3Client. */
async function makeBackend(overrides?: Partial<S3StorageBackendConfig>): Promise<{
  backend: S3StorageBackend;
  mockSend: ReturnType<typeof vi.fn>;
}> {
  const mockSend = vi.fn();

  // The SDK is an optional peer, so the client exists only after the first use.
  // Constructing the backend is offline either way; `connection()` is what
  // resolves the peer and builds the client the assertions below stub.
  const backend = new S3StorageBackend({
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIA-test',
    secretAccessKey: 'test-secret',
    ...overrides,
  });
  await (backend as unknown as { connection(): Promise<{ client: S3Client }> }).connection();

  // Override the internal client.send method
  Object.assign(clientOf(backend), { send: mockSend });

  return { backend, mockSend };
}

// ── Suite ────────────────────────────────────────────────────────

describe('S3StorageBackend — AC 50.x: Production S3 Storage Backend', () => {
  const uploadedFiles: string[] = [];

  afterEach(() => {
    // Cleanup temp files
    for (const f of uploadedFiles) {
      try {
        const dir = f.substring(0, f.lastIndexOf('/'));
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    uploadedFiles.length = 0;
  });

  // AC 50.1: Single-part upload
  it('AC 50.1: should upload file via single-part PutObject', async () => {
    const sourcePath = createTempFile('test.txt', 'hello s3');
    uploadedFiles.push(sourcePath);
    const { backend, mockSend } = await makeBackend();

    mockSend.mockResolvedValueOnce({ ETag: '"abc123"' });

    await backend.upload(sourcePath, 'backups/test.txt');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.constructor.name).toBe('PutObjectCommand');
    expect(command.input.Bucket).toBe('test-bucket');
    expect(command.input.Key).toBe('backups/test.txt');
    const bodyStr = command.input.Body.toString('utf-8');
    expect(bodyStr).toBe('hello s3');
  });

  // AC 50.2: Download
  it('AC 50.2: should download file via GetObject', async () => {
    const { backend, mockSend } = await makeBackend();
    const destPath = createTempFile('download-dest.txt', '');
    uploadedFiles.push(destPath);

    // Mock GetObject response
    const { Readable } = await import('stream');
    const mockBody = Readable.from([Buffer.from('downloaded content')]);
    Object.assign(mockBody, {
      transformToByteArray: vi.fn(async () => Buffer.from('downloaded content')),
    });

    mockSend.mockResolvedValueOnce({ Body: mockBody });

    await backend.download('backups/backup-1.snapshot', destPath);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input.Key).toBe('backups/backup-1.snapshot');

    const content = readFileSync(destPath, 'utf-8');
    expect(content).toBe('downloaded content');
  });

  // AC 50.3: List with prefix
  it('AC 50.3: should list objects with prefix', async () => {
    const { backend, mockSend } = await makeBackend();

    mockSend.mockResolvedValueOnce({
      Contents: [
        {
          Key: 'backups/snap-1',
          Size: 100,
          LastModified: new Date('2026-01-01'),
        },
        {
          Key: 'backups/snap-2',
          Size: 200,
          LastModified: new Date('2026-01-02'),
        },
      ],
    });

    const results = await backend.list('backups/');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.constructor.name).toBe('ListObjectsV2Command');
    expect(command.input.Prefix).toBe('backups/');
    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe('backups/snap-1');
    expect(results[0]!.size).toBe(100);
  });

  // AC 50.4: Delete
  it('AC 50.4: should delete object', async () => {
    const { backend, mockSend } = await makeBackend();

    mockSend.mockResolvedValueOnce({});

    await backend.delete('backups/snap-1');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.constructor.name).toBe('DeleteObjectCommand');
    expect(command.input.Key).toBe('backups/snap-1');
  });

  // AC 50.5: Health check
  it('AC 50.5: should report healthy when bucket is accessible', async () => {
    const { backend, mockSend } = await makeBackend();

    // HeadObject returns NotFound → still healthy
    const notFound = new Error('Not Found');
    notFound.name = 'NotFound';
    mockSend.mockRejectedValueOnce(notFound);

    const result = await backend.health();
    expect(result.ok).toBe(true);
  });

  // AC 50.6: Retry on transient error
  it('AC 50.6: should retry on transient S3 error', async () => {
    const { backend, mockSend } = await makeBackend();
    const sourcePath = createTempFile('retry.txt', 'retry data');
    uploadedFiles.push(sourcePath);

    // First call fails, second succeeds
    mockSend.mockRejectedValueOnce(new Error('Service Unavailable'));
    mockSend.mockResolvedValueOnce({ ETag: '"retry"' });

    await backend.upload(sourcePath, 'backups/retry-test');

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  // AC 50.7: Key prefix
  it('AC 50.7: should prepend key prefix to all operations', async () => {
    const { backend, mockSend } = await makeBackend({ keyPrefix: 'production/' });

    mockSend.mockResolvedValueOnce({ ETag: '"prefixed"' });

    const sourcePath = createTempFile('prefixed.txt', 'prefix test');
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, 'backups/test.txt');

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.Key).toBe('production/backups/test.txt');

    // List
    mockSend.mockResolvedValueOnce({
      Contents: [
        {
          Key: 'production/backups/snap-1',
          Size: 50,
          LastModified: new Date(),
        },
      ],
    });

    const results = await backend.list('backups/');
    expect(results[0]!.key).toBe('backups/snap-1');
  });

  // AC 50.8: SSE-S3 encryption
  it('AC 50.8: should include SSE headers when configured', async () => {
    const { backend, mockSend } = await makeBackend({ sse: 's3' });

    mockSend.mockResolvedValueOnce({ ETag: '"sse"' });

    const sourcePath = createTempFile('sse.txt', 'encrypted upload');
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, 'backups/sse-test');

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.ServerSideEncryption).toBe('AES256');
  });

  // AC 50.9: Get usage bytes
  it('AC 50.9: should calculate total usage bytes', async () => {
    const { backend, mockSend } = await makeBackend();

    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'obj-1', Size: 500 },
        { Key: 'obj-2', Size: 1500 },
      ],
    });

    const usage = await backend.getUsageBytes();
    expect(usage).toBe(2000);
  });

  // AC 50.10: Destroy releases client
  it('AC 50.10: destroy() should close S3 client', async () => {
    const { backend } = await makeBackend();
    const destroySpy = vi.fn();
    Object.assign(clientOf(backend), { destroy: destroySpy });
    Object.assign(backend, { closed: false });

    backend.destroy();
    expect(destroySpy).toHaveBeenCalled();
    expect(isClosed(backend)).toBe(true);

    // Second call should be noop
    backend.destroy();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  // AC 50.11: SSE-KMS with key ID
  it('AC 50.11: should include SSE-KMS headers', async () => {
    const { backend, mockSend } = await makeBackend({
      sse: 'kms',
      sseKmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/my-key',
    });

    mockSend.mockResolvedValueOnce({
      ETag: '"kms"',
      ServerSideEncryption: 'aws:kms',
    });

    const sourcePath = createTempFile('kms.txt', 'kms upload');
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, 'backups/kms-test');

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.ServerSideEncryption).toBe('aws:kms');
    expect(command.input.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/my-key');
  });

  // AC 50.12: Empty list
  it('AC 50.12: should return empty list when no objects match prefix', async () => {
    const { backend, mockSend } = await makeBackend();

    mockSend.mockResolvedValueOnce({ Contents: [] });

    const results = await backend.list('nonexistent/');
    expect(results).toHaveLength(0);
  });

  // AC 50.13: Health check — connection error
  it('AC 50.13: should report unhealthy on connection error', async () => {
    const { backend, mockSend } = await makeBackend();

    mockSend.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await backend.health();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Connection refused');
  });
});

// ── Retry policy: transient vs permanent failures ────────────────

describe('S3StorageBackend — retry policy', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const f of created.splice(0)) {
      rmSync(f.substring(0, f.lastIndexOf('/')), { recursive: true, force: true });
    }
  });

  it('retries a 503 and surfaces the last error once the attempts are spent', async () => {
    const sourcePath = createTempFile('exhausted.txt', 'payload');
    created.push(sourcePath);
    const { backend, mockSend } = await makeBackend();
    mockSend.mockRejectedValue(s3Error(503, 'ServiceUnavailable', 'Service Unavailable'));

    await expect(backend.upload(sourcePath, 'backups/exhausted')).rejects.toThrow('Service Unavailable');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('retries a throttled 429 response', async () => {
    const sourcePath = createTempFile('throttled.txt', 'payload');
    created.push(sourcePath);
    const { backend, mockSend } = await makeBackend();
    mockSend.mockRejectedValueOnce(s3Error(429, 'SlowDown', 'Please reduce your request rate'));
    mockSend.mockResolvedValueOnce({ ETag: '"after-throttle"' });

    await backend.upload(sourcePath, 'backups/throttled');

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403: a rejected credential is not a transient fault', async () => {
    const sourcePath = createTempFile('forbidden.txt', 'payload');
    created.push(sourcePath);
    const { backend, mockSend } = await makeBackend();
    mockSend.mockRejectedValue(s3Error(403, 'AccessDenied', 'Access Denied'));

    await expect(backend.upload(sourcePath, 'backups/forbidden')).rejects.toThrow('Access Denied');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('does not retry a delete that S3 rejects with a 404, and keeps the prefixed key', async () => {
    const { backend, mockSend } = await makeBackend({ keyPrefix: 'production/' });
    mockSend.mockRejectedValue(s3Error(404, 'NoSuchKey', 'The specified key does not exist.'));

    await expect(backend.delete('backups/missing')).rejects.toThrow('does not exist');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0];
    expect(command.constructor.name).toBe('DeleteObjectCommand');
    expect(command.input.Key).toBe('production/backups/missing');
  });
});

// ── Multipart upload contract ────────────────────────────────────

describe('S3StorageBackend — multipart upload', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const f of created.splice(0)) {
      rmSync(f.substring(0, f.lastIndexOf('/')), { recursive: true, force: true });
    }
  });

  /**
   * Capture what the backend hands to the uploader without letting it reach the
   * network. The real Upload constructor still runs, so its own validation of
   * params (bucket, key, body) applies. The body is a file stream, so it is
   * drained here: a stream left unread would open the temp file after the test
   * has deleted it.
   */
  /** What the backend handed the uploader for one multipart upload. */
  interface MultipartCall {
    bucket: string | undefined;
    key: string | undefined;
    partSize: number;
    queueSize: number;
    sse: string | undefined;
    kmsKeyId: string | undefined;
    bytes: Buffer;
  }

  /**
   * Capture what the backend hands to the uploader without letting it reach the
   * network. The real Upload constructor still runs, so its own validation of
   * params (bucket, key, body) applies. The body is a file stream, so it is
   * drained here: a stream left unread would open the temp file after the test
   * has deleted it.
   */
  function captureUpload(): { calls: MultipartCall[]; restore: () => void } {
    const calls: MultipartCall[] = [];
    const spy = vi.spyOn(Upload.prototype, 'done').mockImplementation(function (this: Upload) {
      const upload = this as unknown as UploadInternals;
      const body = upload.params.Body as AsyncIterable<Uint8Array>;
      return (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        calls.push({
          bucket: upload.params.Bucket,
          key: upload.params.Key,
          partSize: upload.partSize,
          queueSize: upload.queueSize,
          sse: upload.params.ServerSideEncryption,
          kmsKeyId: upload.params.SSEKMSKeyId,
          bytes: Buffer.concat(chunks),
        });
        return {} as UploadResult;
      })();
    });
    return { calls, restore: () => spy.mockRestore() };
  }

  it('uploads through the multipart uploader once the file reaches the threshold', async () => {
    const sourcePath = createTempFile('multipart.bin', 'twelve bytes');
    created.push(sourcePath);
    const { backend } = await makeBackend({ multipartThreshold: 4 });
    const { calls, restore } = captureUpload();

    try {
      await backend.upload(sourcePath, 'backups/multipart.bin');
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.bucket).toBe('test-bucket');
    expect(calls[0]!.key).toBe('backups/multipart.bin');
    expect(calls[0]!.queueSize).toBe(4);
    expect(calls[0]!.bytes.toString('utf-8')).toBe('twelve bytes');
  });

  it('uses the 5 MiB minimum part size by default', async () => {
    const sourcePath = createTempFile('default-part.bin', 'twelve bytes');
    created.push(sourcePath);
    const { backend } = await makeBackend({ multipartThreshold: 4 });
    const { calls, restore } = captureUpload();

    try {
      await backend.upload(sourcePath, 'backups/default-part.bin');
    } finally {
      restore();
    }

    // Anything below 5 MiB is rejected by S3 for every part but the last.
    expect(calls[0]!.partSize).toBe(5 * 1024 * 1024);
  });

  it('honours a configured part size and applies SSE-KMS to every part', async () => {
    const sourcePath = createTempFile('kms-multipart.bin', 'twelve bytes');
    created.push(sourcePath);
    const { backend } = await makeBackend({
      multipartThreshold: 4,
      partSize: 8 * 1024 * 1024,
      sse: 'kms',
      sseKmsKeyId: 'kms-key',
    });
    const { calls, restore } = captureUpload();

    try {
      await backend.upload(sourcePath, 'backups/kms-multipart.bin');
    } finally {
      restore();
    }

    expect(calls[0]!.partSize).toBe(8 * 1024 * 1024);
    expect(calls[0]!.sse).toBe('aws:kms');
    expect(calls[0]!.kmsKeyId).toBe('kms-key');
  });
});

// ── SSE-C, pagination and listing edge cases ─────────────────────

describe('S3StorageBackend — encryption and listing edge cases', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const f of created.splice(0)) {
      rmSync(f.substring(0, f.lastIndexOf('/')), { recursive: true, force: true });
    }
  });

  it('tags a single-part upload with the SSE-C customer key', async () => {
    const sourcePath = createTempFile('sse-c.txt', 'customer key');
    created.push(sourcePath);
    const { backend, mockSend } = await makeBackend({ sse: 'c', sseCustomerKey: 'dGVzdC1rZXktMzI=' });
    mockSend.mockResolvedValueOnce({ ETag: '"sse-c"' });

    await backend.upload(sourcePath, 'backups/sse-c');

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.SSECustomerAlgorithm).toBe('AES256');
    expect(command.input.SSECustomerKey).toBe('dGVzdC1rZXktMzI=');
    expect(command.input.ServerSideEncryption).toBeUndefined();
  });

  it('sends no encryption parameters when SSE-C is selected without a customer key', async () => {
    const sourcePath = createTempFile('sse-c-missing.txt', 'no key');
    created.push(sourcePath);
    const { backend, mockSend } = await makeBackend({ sse: 'c' });
    mockSend.mockResolvedValueOnce({ ETag: '"plain"' });

    await backend.upload(sourcePath, 'backups/sse-c-missing');

    const command = mockSend.mock.calls[0]![0];
    expect(command.input.SSECustomerAlgorithm).toBeUndefined();
    expect(command.input.SSECustomerKey).toBeUndefined();
  });

  it('follows the continuation token until the listing is complete', async () => {
    const { backend, mockSend } = await makeBackend();
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'p/a', Size: 1, LastModified: new Date('2026-01-01T00:00:00Z') }],
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'p/b', Size: 2 }] });

    const results = await backend.list('p/');

    expect(mockSend).toHaveBeenCalledTimes(2);
    const second = mockSend.mock.calls[1]![0];
    expect(second.constructor.name).toBe('ListObjectsV2Command');
    expect(second.input.ContinuationToken).toBe('page-2');
    expect(results.map((r) => r.key)).toEqual(['p/a', 'p/b']);
    expect(results[0]!.lastModified).toBe('2026-01-01T00:00:00.000Z');
  });

  it('skips listing entries without a key and defaults the missing fields', async () => {
    const { backend, mockSend } = await makeBackend();
    mockSend.mockResolvedValueOnce({ Contents: [{ Size: 9 }, { Key: 'p/only-key' }] });

    const results = await backend.list('p/');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ key: 'p/only-key', size: 0, lastModified: '' });
  });

  it('sums only the sizes S3 reports and tolerates a listing without contents', async () => {
    const { backend, mockSend } = await makeBackend();
    mockSend.mockResolvedValueOnce({ Contents: [{ Key: 'a', Size: 7 }, { Key: 'b' }] });
    expect(await backend.getUsageBytes()).toBe(7);

    mockSend.mockResolvedValueOnce({});
    expect(await backend.getUsageBytes()).toBe(0);
  });

  it('reports healthy when the probe object is readable', async () => {
    const { backend, mockSend } = await makeBackend();
    mockSend.mockResolvedValueOnce({ ContentLength: 0 });

    expect(await backend.health()).toEqual({ ok: true });
  });

  it('stringifies a non-Error failure from the health probe', async () => {
    const { backend, mockSend } = await makeBackend();
    mockSend.mockRejectedValueOnce('socket hang up');

    expect(await backend.health()).toEqual({ ok: false, message: 'socket hang up' });
  });

  it('retries a download whose first response carries no body', async () => {
    const destPath = createTempFile('late-body.bin', '');
    created.push(destPath);
    const { backend, mockSend } = await makeBackend();
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => Buffer.from('late body') },
    });

    await backend.download('backups/late', destPath);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(readFileSync(destPath, 'utf-8')).toBe('late body');
  });

  it('forces path-style addressing when configured for an S3-compatible endpoint', async () => {
    const { backend } = await makeBackend({ endpoint: 'http://localhost:9000', forcePathStyle: true });
    const config = clientOf(backend).config;

    expect(config.forcePathStyle).toBe(true);
    const resolveEndpoint = config.endpoint as unknown as () => Promise<{
      protocol: string;
      hostname: string;
      port: number;
    }>;
    expect(await resolveEndpoint()).toMatchObject({
      protocol: 'http:',
      hostname: 'localhost',
      port: 9000,
    });
  });
});
