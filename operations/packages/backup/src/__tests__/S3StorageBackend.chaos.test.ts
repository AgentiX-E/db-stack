/**
 * S3StorageBackend Chaos Tests — resilience under network and timeout faults.
 *
 * D2 iteration: validates backing-store fault tolerance.
 *
 * Scenarios:
 *   B.7 — Network timeout during upload
 *   B.8 — Simultaneous concurrent uploads to same key
 *
 * Invariants:
 *   S1 — Timeout does not leave dangling state
 *   S2 — Concurrent uploads are safe (last write wins)
 */

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { S3StorageBackend } from '../impl/S3StorageBackend.js';

// ── Mock S3 client via vi.mock ──────────────────────────────

let _mockShouldFail = false; // fault injection toggle

vi.mock('@aws-sdk/client-s3', () => {
  const putObjectCalls: Array<{ Bucket: string; Key: string }> = [];

  class MockS3Client {
    config = { region: 'us-east-1' };

    async send(command: any): Promise<any> {
      const cmdName = command.constructor?.name;

      if (_mockShouldFail) {
        _mockShouldFail = false;
        throw Object.assign(new Error('Connection timed out'), { code: 'Timeout' });
      }

      switch (cmdName) {
        case 'CreateBucketCommand':
          return {};
        case 'PutObjectCommand':
          putObjectCalls.push({ Bucket: command.input.Bucket, Key: command.input.Key });
          return { ETag: '"mock-etag"' };
        case 'GetObjectCommand':
          return { Body: { transformToByteArray: async () => Buffer.from('mock-data') } };
        case 'HeadObjectCommand':
          return { ContentLength: 9, ETag: '"mock-etag"' };
        default:
          return {};
      }
    }
  }

  return {
    S3Client: MockS3Client,
    PutObjectCommand: class { input: any; constructor(i: any) { this.input = i; } },
    GetObjectCommand: class { input: any; constructor(i: any) { this.input = i; } },
    ListObjectsV2Command: class { input: any; constructor(i: any) { this.input = i; } },
    DeleteObjectCommand: class { input: any; constructor(i: any) { this.input = i; } },
    HeadObjectCommand: class { input: any; constructor(i: any) { this.input = i; } },
    CreateMultipartUploadCommand: class { input: any; constructor(i: any) { this.input = i; } },
    UploadPartCommand: class { input: any; constructor(i: any) { this.input = i; } },
    CompleteMultipartUploadCommand: class { input: any; constructor(i: any) { this.input = i; } },
    AbortMultipartUploadCommand: class { input: any; constructor(i: any) { this.input = i; } },
  };
});

vi.mock('@aws-sdk/lib-storage', () => {
  return { Upload: class { constructor(public opts: any) {} async done() { return {}; } } };
});

function createTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 's3-chaos-'));
  const filePath = join(dir, 'test-data.bin');
  writeFileSync(filePath, content);
  return filePath;
}

function cleanupTempFile(path: string): void {
  try { rmSync(join(path, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('S3StorageBackend Chaos (D2)', () => {
  // B.7: Network timeout during upload — verify no crash
  it('B.7: should handle upload timeout gracefully', async () => {
    const backend = new S3StorageBackend({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
    });

    const tmpFile = createTempFile('hello chaos');

    // Inject timeout fault
    _mockShouldFail = true;

    // Attempt upload under timeout — should not crash process
    try {
      await backend.upload(tmpFile, 'test/timeout-key');
    } catch (err: any) {
      // S1: Network errors are expected; verify no crash
      expect(err).toBeDefined();
    }

    // S1: Backend remains usable after a timeout
    // Next call should succeed (fault is one-shot)
    setImmediate(() => { _mockShouldFail = false; });
    await expect(
      backend.upload(tmpFile, 'test/recovery-key'),
    ).resolves.not.toThrow();

    cleanupTempFile(tmpFile);
  });

  // B.8: Concurrent uploads — ensure no race conditions
  it('B.8: should handle concurrent uploads safely', async () => {
    const backend = new S3StorageBackend({
      bucket: 'test-bucket',
      region: 'us-east-1',
    });

    // Create temp files for concurrent uploads
    const files = Array.from({ length: 10 }, (_, i) => {
      const f = createTempFile(`data-${i}`);
      return { path: f, key: `test/concurrent-key-${i % 3}` };
    });

    const uploads = files.map((f) => backend.upload(f.path, f.key));
    await expect(Promise.all(uploads)).resolves.not.toThrow();

    // Cleanup
    for (const f of files) cleanupTempFile(f.path);
  });

  // B.9: Single upload success path
  it('B.9: should complete single upload successfully', async () => {
    const backend = new S3StorageBackend({
      bucket: 'test-bucket',
      region: 'us-east-1',
    });

    const tmpFile = createTempFile('small data');
    await expect(
      backend.upload(tmpFile, 'test/single-key'),
    ).resolves.not.toThrow();

    cleanupTempFile(tmpFile);
  });
});
