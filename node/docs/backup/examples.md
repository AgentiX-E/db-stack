# Examples

Every block below is self-contained: it declares what it uses, so it can be pasted into a file on its
own.

## A storage backend that is not S3

`IStorageBackend` is seven methods. Anything that can hold a byte can be a bucket — a filesystem, an
object store, a tape robot behind an HTTP API. The only method with a non-obvious duty is `list`, which
`createBackup` uses to confirm the upload:

```typescript
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IStorageBackend } from '@agentix-e/db-node/backup';

/** A bucket that is a directory. Keys become paths, so `list` is a directory walk. */
class DirectoryBucket implements IStorageBackend {
  readonly name = 'directory-bucket';

  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    return join(this.root, key);
  }

  async upload(sourcePath: string, destKey: string): Promise<void> {
    const destination = this.pathOf(destKey);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(sourcePath));
  }

  async download(sourceKey: string, destPath: string): Promise<void> {
    await writeFile(destPath, await readFile(this.pathOf(sourceKey)));
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const directory = this.pathOf(prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '.');
    const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const listed: Array<{ key: string; size: number; lastModified: string }> = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      const full = join(directory, entry.name);
      const info = await stat(full);
      const key = `${prefix.slice(0, prefix.lastIndexOf('/') + 1)}${entry.name}`;
      if (!key.startsWith(prefix)) continue;
      listed.push({ key, size: info.size, lastModified: info.mtime.toISOString() });
    }
    return listed;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return stat(this.root).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, message: String(error) }),
    );
  }

  async getUsageBytes(): Promise<number> {
    return 0;
  }
}
```

A `list` that returns a stale view is not a small problem: the manager will refuse to record the
snapshot, because the one thing it will not do is claim a backup the bucket cannot answer for.

## An engine source

`capture` produces a consistent cut and reports what it wrote. `restore` replaces the engine's state.
Everything else — hashing, upload, confirmation, the chain, retention — is the manager's:

```typescript
import { readDirectoryArtifact, writeDirectoryArtifact } from '@agentix-e/db-node/backup';
import type { IBackupSource, SnapshotCapture } from '@agentix-e/db-node/backup';

/**
 * A source that adds the one fact a restore decision needs: where the log was.
 * An engine records it while quiesced; here it comes from the environment so the
 * example does not pretend to know an engine's internals.
 */
class WalAwareSource implements IBackupSource {
  readonly name = 'postgres-16';

  constructor(private readonly dataDir: string) {}

  async capture(destination: string): Promise<SnapshotCapture> {
    const cut = await writeDirectoryArtifact(this.dataDir, destination);
    return {
      bytes: cut.bytes,
      files: cut.files,
      facts: { lsn: process.env.DB_CHECKPOINT_LSN ?? '0/0', 'dir.bytes': String(cut.sourceBytes) },
    };
  }

  async restore(source: string): Promise<void> {
    await readDirectoryArtifact(source, this.dataDir);
  }
}
```

`capture` must not resolve with a partial artefact — the manager uploads exactly the file it named — and
it must not resolve for a moving target: `writeDirectoryArtifact` hashes, copies, then re-hashes, and
refuses the capture if a file changed in between.

## Create, inspect, restore

```typescript
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-node/backup';

const manager = new BackupManager(
  new DirectoryBackupSource('/var/lib/db/data'),
  new InMemoryStorageBackend(),
  new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1_073_741_824 }),
);

const created = await manager.createBackup({ type: 'full', tags: { reason: 'pre-upgrade' } });
if (!created.success) {
  // The message names the step: capture, upload, or the bucket's confirmation.
  throw new Error(created.error);
}

const metadata = await manager.getBackup(created.snapshot!.snapshotId);
console.log(metadata?.sizeBytes, metadata?.fileCount, metadata?.checksum);

const restored = await manager.restoreFromSnapshot(created.snapshot!.snapshotId);
console.log(restored.success, restored.recoveryPoint, restored.durationMs);
```

`recoveryPoint` on a plain snapshot restore is the snapshot that was replayed, not an invented timestamp.

## Point-in-time recovery

```typescript
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-node/backup';

const manager = new BackupManager(
  new DirectoryBackupSource('/var/lib/db/data'),
  new InMemoryStorageBackend(),
  new RetentionPolicyEvaluator({ maxFullSnapshots: 24, maxTotalBytes: 500_000_000_000 }),
);

await manager.createBackup({ type: 'full' });

// By timestamp: the newest completed snapshot at or before it.
const byTime = await manager.pitr({ targetTime: '2026-07-12T10:00:00Z' });

// By log position: the newest completed snapshot whose recorded `lsn` is at or before it.
const byLsn = await manager.pitr({ targetLsn: '16/B374D848' });

// A target that names nothing is refused rather than guessed at.
const refused = await manager.pitr({});
console.log(byTime.success, byLsn.recoveryPoint, refused.error);
```

`compareLsn` is what makes the second call correct: LSNs are `segment/offset` in hex, and comparing them
as strings puts `16/9` after `16/10` — a restore to the wrong minute.

## Retention that keeps chains whole

```typescript
import { RetentionPolicyEvaluator, parseDurationToMs } from '@agentix-e/db-node/backup';

const retention = new RetentionPolicyEvaluator({
  maxFullSnapshots: 7,
  keepRecent: 'P7D',
  minAge: 'PT1H',
  maxTotalBytes: 500_000_000_000,
});

console.log(parseDurationToMs('P7D')); // 604800000

const inventory = await manager.listBackups();
const { toDelete, unreclaimedBytes } = retention.evaluateWithOutcome(inventory);
for (const snapshot of toDelete) await manager.deleteBackup(snapshot.snapshotId);

if (unreclaimedBytes > 0) {
  // The floors forbid getting under the ceiling. That is a fact about the
  // deployment, not a bug in the evaluator: raise the limit, shorten a floor, or
  // add storage.
  console.warn(`retention could not reclaim ${unreclaimedBytes} bytes`);
}
```

`deleteBackup` cascades to the snapshots that cannot be replayed without the one named, so a delete list
that names a base removes its deltas too — and `prune()` returns what was actually deleted rather than
what the policy asked for.

## Reading an artefact without a manager

A restore drill, a forensic inspection, or a migration tool may need the container itself. The format is
published for exactly that reason:

```typescript
import { ARTIFACT_MAGIC, MAX_MANIFEST_BYTES, hashFile, readDirectoryArtifact, safeJoin } from '@agentix-e/db-node/backup';

const digest = await hashFile('/var/backups/snap-lz1.artifact');
console.log(ARTIFACT_MAGIC, digest.sha256, digest.size);

// `maxManifestBytes` is a parameter so a deployment with an unusual tree can raise it.
const outcome = await readDirectoryArtifact('/var/backups/snap-lz1.artifact', '/var/lib/db/data', {
  maxManifestBytes: MAX_MANIFEST_BYTES,
});
console.log(`restored ${outcome.files} files in ${outcome.dirs} directories`);

// A manifest path is data from a bucket, so it is joined through `safeJoin`, which
// refuses `..` and absolute paths before a byte is written.
try {
  safeJoin('/var/lib/db/data', '../../etc/cron.d/x');
} catch (error) {
  console.error(error);
}
```
