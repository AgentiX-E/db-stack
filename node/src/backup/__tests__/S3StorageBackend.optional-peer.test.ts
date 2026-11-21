/**
 * S3StorageBackend — the AWS SDK is an optional peer (AC-S3P 1–5).
 *
 * `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` sit in `peerDependencies` with
 * `optional: true`, which is a claim about three things that a manifest cannot
 * prove:
 *
 *   1. the module loads without them — a static import would make the peers
 *      mandatory in practice, because the umbrella entry point re-exports this
 *      file, so `import '@agentix-e/db-node'` would throw for every
 *      consumer that does not use S3;
 *   2. constructing the backend does not need them — a deployment configures the
 *      backend while it loads its configuration, not while it backs something up;
 *   3. reaching the S3 path without them is a refusal that names the two packages
 *      and the command that installs them, not a `MODULE_NOT_FOUND` from a
 *      bundler two frames down.
 *
 * The two `vi.mock` factories below throw on import, which is the closest an
 * in-process test gets to "this package is not installed": were the import
 * static, this file would fail during collection rather than at an assertion.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => {
  throw new Error("Cannot find package '@aws-sdk/client-s3' imported from S3StorageBackend.js");
});

vi.mock('@aws-sdk/lib-storage', () => {
  throw new Error("Cannot find package '@aws-sdk/lib-storage' imported from S3StorageBackend.js");
});

import { S3StorageBackend, type S3StorageBackendConfig } from '../impl/S3StorageBackend.js';

const CONFIG: S3StorageBackendConfig = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'test-secret',
};

/** The refusal every S3 path produces when the peers are absent. */
const REFUSAL = /optional peer dependencies @aws-sdk\/client-s3 and @aws-sdk\/lib-storage/;

describe('S3StorageBackend — optional peer dependencies', () => {
  it('AC-S3P 1: the module loads, and the class is usable as a value, without the SDK', () => {
    expect(typeof S3StorageBackend).toBe('function');
    expect(new S3StorageBackend(CONFIG).name).toBe('s3');
  });

  it('AC-S3P 2: constructing the backend does not resolve the peer', () => {
    // The configuration is kept, not acted on: a constructor that resolved the
    // peer would fail here, in the process that merely registers storage
    // backends it may never use.
    expect(() => new S3StorageBackend({ ...CONFIG, sse: 'kms', sseKmsKeyId: 'key' })).not.toThrow();
  });

  it('AC-S3P 3: a request is refused with the packages named and the install command spelled out', async () => {
    const backend = new S3StorageBackend(CONFIG);

    await expect(backend.delete('backups/a')).rejects.toThrow(REFUSAL);
    await expect(backend.list('backups/')).rejects.toThrow(REFUSAL);
    await expect(backend.getUsageBytes()).rejects.toThrow(REFUSAL);
    await expect(backend.download('backups/a', '/tmp/unused')).rejects.toThrow(REFUSAL);
  });

  it('AC-S3P 4: the refusal is the backend’s own message, with the loader error kept as its cause', async () => {
    const backend = new S3StorageBackend(CONFIG);

    const error = await backend.delete('backups/a').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('npm install @aws-sdk/client-s3 @aws-sdk/lib-storage');
    // The reader gets one actionable sentence; the operator who needs the stack
    // gets the loader's own failure under `cause`, not concatenated into it.
    expect((error as Error).message).not.toContain('Cannot find package');
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('AC-S3P 5: health reports the missing peer instead of throwing, and is not cached as healthy', async () => {
    const backend = new S3StorageBackend(CONFIG);

    const first = await backend.health();
    const second = await backend.health();

    expect(first.ok).toBe(false);
    expect(first.message).toMatch(REFUSAL);
    // A failed load is not cached: the second call tries again, which is what
    // lets a process pick up a peer that was installed after it started.
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(REFUSAL);
  });
});
