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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { S3StorageBackend, type S3StorageBackendConfig } from "../impl/S3StorageBackend.js";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helper ───────────────────────────────────────────────────────

/** Create a temp file with given content. */
function createTempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "s3-test-"));
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

/** Create S3StorageBackend with a mocked S3Client. */
function makeBackend(overrides?: Partial<S3StorageBackendConfig>): {
  backend: S3StorageBackend;
  mockSend: ReturnType<typeof vi.fn>;
} {
  const mockSend = vi.fn();

  // We need to mock the S3Client constructor globally
  // Instead, we rely on the fact that S3StorageBackend's S3Client is internal.
  // We'll mock the client via vi.mock('@aws-sdk/client-s3').

  const backend = new S3StorageBackend({
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "AKIA-test",
    secretAccessKey: "test-secret",
    ...overrides,
  });

  // Override the internal client.send method
  (backend as any).client.send = mockSend;

  return { backend, mockSend };
}

// ── Suite ────────────────────────────────────────────────────────

describe("S3StorageBackend — AC 50.x: Production S3 Storage Backend", () => {
  const uploadedFiles: string[] = [];

  afterEach(() => {
    // Cleanup temp files
    for (const f of uploadedFiles) {
      try {
        const dir = f.substring(0, f.lastIndexOf("/"));
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    uploadedFiles.length = 0;
  });

  // AC 50.1: Single-part upload
  it("AC 50.1: should upload file via single-part PutObject", async () => {
    const sourcePath = createTempFile("test.txt", "hello s3");
    uploadedFiles.push(sourcePath);
    const { backend, mockSend } = makeBackend();

    mockSend.mockResolvedValueOnce({ ETag: '"abc123"' });

    await backend.upload(sourcePath, "backups/test.txt");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.constructor.name).toBe("PutObjectCommand");
    expect(command.input.Bucket).toBe("test-bucket");
    expect(command.input.Key).toBe("backups/test.txt");
    const bodyStr = command.input.Body.toString("utf-8");
    expect(bodyStr).toBe("hello s3");
  });

  // AC 50.2: Download
  it("AC 50.2: should download file via GetObject", async () => {
    const { backend, mockSend } = makeBackend();
    const destPath = createTempFile("download-dest.txt", "");
    uploadedFiles.push(destPath);

    // Mock GetObject response
    const { Readable } = await import("stream");
    const mockBody = Readable.from([Buffer.from("downloaded content")]);
    (mockBody as any).transformToByteArray = vi.fn(async () =>
      Buffer.from("downloaded content"),
    );

    mockSend.mockResolvedValueOnce({ Body: mockBody });

    await backend.download("backups/backup-1.snapshot", destPath);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.constructor.name).toBe("GetObjectCommand");
    expect(command.input.Key).toBe("backups/backup-1.snapshot");

    const content = readFileSync(destPath, "utf-8");
    expect(content).toBe("downloaded content");
  });

  // AC 50.3: List with prefix
  it("AC 50.3: should list objects with prefix", async () => {
    const { backend, mockSend } = makeBackend();

    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "backups/snap-1", Size: 100, LastModified: new Date("2026-01-01") },
        { Key: "backups/snap-2", Size: 200, LastModified: new Date("2026-01-02") },
      ],
    });

    const results = await backend.list("backups/");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.constructor.name).toBe("ListObjectsV2Command");
    expect(command.input.Prefix).toBe("backups/");
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("backups/snap-1");
    expect(results[0].size).toBe(100);
  });

  // AC 50.4: Delete
  it("AC 50.4: should delete object", async () => {
    const { backend, mockSend } = makeBackend();

    mockSend.mockResolvedValueOnce({});

    await backend.delete("backups/snap-1");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.constructor.name).toBe("DeleteObjectCommand");
    expect(command.input.Key).toBe("backups/snap-1");
  });

  // AC 50.5: Health check
  it("AC 50.5: should report healthy when bucket is accessible", async () => {
    const { backend, mockSend } = makeBackend();

    // HeadObject returns NotFound → still healthy
    const notFound = new Error("Not Found");
    notFound.name = "NotFound";
    mockSend.mockRejectedValueOnce(notFound);

    const result = await backend.health();
    expect(result.ok).toBe(true);
  });

  // AC 50.6: Retry on transient error
  it("AC 50.6: should retry on transient S3 error", async () => {
    const { backend, mockSend } = makeBackend();
    const sourcePath = createTempFile("retry.txt", "retry data");
    uploadedFiles.push(sourcePath);

    // First call fails, second succeeds
    mockSend.mockRejectedValueOnce(new Error("Service Unavailable"));
    mockSend.mockResolvedValueOnce({ ETag: '"retry"' });

    await backend.upload(sourcePath, "backups/retry-test");

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  // AC 50.7: Key prefix
  it("AC 50.7: should prepend key prefix to all operations", async () => {
    const { backend, mockSend } = makeBackend({ keyPrefix: "production/" });

    mockSend.mockResolvedValueOnce({ ETag: '"prefixed"' });

    const sourcePath = createTempFile("prefixed.txt", "prefix test");
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, "backups/test.txt");

    const command = mockSend.mock.calls[0][0];
    expect(command.input.Key).toBe("production/backups/test.txt");

    // List
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "production/backups/snap-1", Size: 50, LastModified: new Date() },
      ],
    });

    const results = await backend.list("backups/");
    expect(results[0].key).toBe("backups/snap-1");
  });

  // AC 50.8: SSE-S3 encryption
  it("AC 50.8: should include SSE headers when configured", async () => {
    const { backend, mockSend } = makeBackend({ sse: "s3" });

    mockSend.mockResolvedValueOnce({ ETag: '"sse"' });

    const sourcePath = createTempFile("sse.txt", "encrypted upload");
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, "backups/sse-test");

    const command = mockSend.mock.calls[0][0];
    expect(command.input.ServerSideEncryption).toBe("AES256");
  });

  // AC 50.9: Get usage bytes
  it("AC 50.9: should calculate total usage bytes", async () => {
    const { backend, mockSend } = makeBackend();

    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "obj-1", Size: 500 },
        { Key: "obj-2", Size: 1500 },
      ],
    });

    const usage = await backend.getUsageBytes();
    expect(usage).toBe(2000);
  });

  // AC 50.10: Destroy releases client
  it("AC 50.10: destroy() should close S3 client", async () => {
    const { backend } = makeBackend();
    const destroySpy = vi.fn();
    (backend as any).client.destroy = destroySpy;
    (backend as any).closed = false;

    backend.destroy();
    expect(destroySpy).toHaveBeenCalled();
    expect((backend as any).closed).toBe(true);

    // Second call should be noop
    backend.destroy();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  // AC 50.11: SSE-KMS with key ID
  it("AC 50.11: should include SSE-KMS headers", async () => {
    const { backend, mockSend } = makeBackend({
      sse: "kms",
      sseKmsKeyId: "arn:aws:kms:us-east-1:123456789:key/my-key",
    });

    mockSend.mockResolvedValueOnce({ ETag: '"kms"', ServerSideEncryption: "aws:kms" });

    const sourcePath = createTempFile("kms.txt", "kms upload");
    uploadedFiles.push(sourcePath);
    await backend.upload(sourcePath, "backups/kms-test");

    const command = mockSend.mock.calls[0][0];
    expect(command.input.ServerSideEncryption).toBe("aws:kms");
    expect(command.input.SSEKMSKeyId).toBe("arn:aws:kms:us-east-1:123456789:key/my-key");
  });

  // AC 50.12: Empty list
  it("AC 50.12: should return empty list when no objects match prefix", async () => {
    const { backend, mockSend } = makeBackend();

    mockSend.mockResolvedValueOnce({ Contents: [] });

    const results = await backend.list("nonexistent/");
    expect(results).toHaveLength(0);
  });

  // AC 50.13: Health check — connection error
  it("AC 50.13: should report unhealthy on connection error", async () => {
    const { backend, mockSend } = makeBackend();

    mockSend.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await backend.health();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Connection refused");
  });
});
