/**
 * AC 102 — a chain is replayed, not assumed away.
 *
 * `restoreFromSnapshot` could always answer *may this be replayed*: `unrestorableReason`
 * walks the parents and reports a missing link or a chain with no base. What it did with
 * that answer was hand `IBackupSource.restore` a single file and call it a restore. For
 * the reference source that is correct — `DirectoryBackupSource` captures a whole tree
 * every time, so the newest artefact is a complete state — but the port also promises a
 * source may capture a delta, and for one of those the same code writes the newest delta
 * over a data directory as if it were a full copy and then reports success. The result is
 * a database restored from a fragment, which is worse than a refusal because it looks
 * like a recovery.
 *
 * The fix is one walk that answers both questions (`resolveChain`) and a port that makes
 * the source say which of the two things it is: `whole: true` for a whole-capture engine,
 * `restoreChain` for one that captures deltas, and — for a source that declares neither —
 * a refusal when a chain longer than one artefact reaches it, named rather than guessed.
 *
 * What each case is for:
 *
 *   CR.1  the roadmap's case: a chain of three reaches a chain-capable source as three
 *         paths, oldest first, and the result says how many were verified
 *   CR.2  the order is the chain's, not the inventory's: base, delta, delta
 *   CR.3  a whole-capture source is handed the newest artefact alone, whatever the chain
 *   CR.4  a source that declares neither is refused by name on a chain of two and of three,
 *         and the engine is never touched
 *   CR.5  a chain-capable source is handed a chain even when the chain has one link, so the
 *         shape of the call does not depend on the length
 *   CR.6  `whole` wins over `restoreChain` when a source declares both
 *   CR.7  a damaged link in the middle is refused, named by its own id, before the engine
 *   CR.8  `skipVerification` skips every link's digest and still refuses a wrong size
 *   CR.9  a chain that cannot be replayed is refused before a single byte is downloaded
 *   CR.10 an engine that rejects the chain is reported as a failure, and the staging is gone
 *   CR.11 staging files do not survive a success, a refusal or a rejection
 *   CR.12 `pitr` reaches the same replay: by id and by time, a chain of three either way
 *   CR.13 `resolveChain` answers the chain and the reason from one walk
 *   CR.14 `resolveChain` refuses a cycle, a missing base and a delta with no root
 *   CR.15 a real delta engine: three captures of one changed file each, restored from an
 *         empty directory into all three files — the case the old code would have turned
 *         into one file and a success
 *   CR.16 the fragment, shown directly: the newest delta applied alone leaves one file
 *   CR.17 snapshots sharing a timestamp are ranked by depth, so the head is the recovery
 *         point rather than the base the listing happened to name first
 *   CR.18 the recovery point does not depend on the order the bucket listed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { inventoryKey } from '../impl/inventory.js';
import { resolveChain } from '../impl/backupChain.js';
import type { IBackupSource, IStorageBackend, SnapshotCapture } from '../interfaces/index.js';
import type { BackupMetadata, RestoreResult } from '../../core/types.js';

let root: string;
let dataDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac102-'));
  dataDir = join(root, 'data');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha-rows');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A source that records what it was handed, over the real directory capture.
 *
 * `deliveries` has one entry per call: `restore` records one path, `restoreChain`
 * records the whole list. That is the only way to see the order, because the call is
 * the seam and the filesystem is downstream of it.
 */
class RecordingSource implements IBackupSource {
  readonly name: string;
  /** Set to `true` to declare a whole-capture engine; set by `wholeSource`. */
  whole?: boolean;
  /** Defined to make the source chain-capable; set by `chainSource`. */
  restoreChain?: (chain: readonly string[]) => Promise<void>;

  /** One entry per delivery: a single path for `restore`, the list for `restoreChain`. */
  readonly deliveries: string[][] = [];
  /** When set, every delivery rejects with this message instead of restoring. */
  failWith: string | null = null;

  constructor(
    private readonly inner: DirectoryBackupSource,
    name = 'recording',
  ) {
    this.name = name;
  }

  async capture(destination: string): Promise<SnapshotCapture> {
    return this.inner.capture(destination);
  }

  async restore(source: string): Promise<void> {
    this.deliveries.push([source]);
    if (this.failWith !== null) throw new Error(this.failWith);
    await this.inner.restore(source);
  }

  /** Every file any delivery named, in the order it was named. */
  flattened(): string[] {
    return this.deliveries.flat();
  }
}

/** A recording source that can replay a chain and says nothing about being whole. */
function chainSource(): RecordingSource {
  const source = new RecordingSource(new DirectoryBackupSource(dataDir));
  source.restoreChain = async (chain) => {
    source.deliveries.push([...chain]);
    if (source.failWith !== null) throw new Error(source.failWith);
  };
  return source;
}

/** A recording source that declares every artefact a whole copy. */
function wholeSource(): RecordingSource {
  const source = new RecordingSource(new DirectoryBackupSource(dataDir));
  source.whole = true;
  return source;
}

/** A recording source that declares neither, which is what a naive engine looks like. */
function plainSource(): RecordingSource {
  return new RecordingSource(new DirectoryBackupSource(dataDir));
}

function managerOver(source: IBackupSource, backend: IStorageBackend = storage): BackupManager {
  return new BackupManager(source, backend, new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }), {
    workDir,
  });
}

/** A bucket with one method replaced and the rest still real. */
function passthrough(overrides: Partial<IStorageBackend>): IStorageBackend {
  return {
    name: 'passthrough',
    upload: storage.upload.bind(storage),
    download: storage.download.bind(storage),
    list: storage.list.bind(storage),
    delete: storage.delete.bind(storage),
    health: storage.health.bind(storage),
    getUsageBytes: storage.getUsageBytes.bind(storage),
    ...overrides,
  };
}

/**
 * A chain of three over one manager: a full, then two incrementals.
 *
 * The base is taken from a directory holding `table.bin`; each delta is preceded by a
 * change, so the three artefacts are three different files and the chain is not a
 * tautology.
 */
async function chainOfThree(manager: BackupManager): Promise<BackupMetadata[]> {
  const base = (await manager.createBackup({ type: 'full' })).snapshot!;
  writeFileSync(join(dataDir, 'second.bin'), 'beta-rows');
  const first = (await manager.createBackup({ type: 'incremental' })).snapshot!;
  writeFileSync(join(dataDir, 'third.bin'), 'gamma-rows');
  const second = (await manager.createBackup({ type: 'incremental' })).snapshot!;
  return [base, first, second];
}

/** The id at the end of a staged path, so a recorded path can be checked against a snapshot. */
function idIn(path: string): string {
  return path
    .replace(/\.restore\.artifact$/, '')
    .split('/')
    .pop()!;
}

describe('AC 102 — replay the chain, or refuse it by name', () => {
  it('CR.1: the roadmap case — three artefacts to a chain-capable source, oldest first', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const [base, first, second] = await chainOfThree(manager);

    const result = await manager.restoreFromSnapshot(second!.snapshotId);

    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe(second!.snapshotId);
    expect(result.artefacts).toBe(3);
    // One call, three paths: the source was handed the chain rather than asked three times.
    expect(source.deliveries).toHaveLength(1);
    expect(source.deliveries[0]!.map(idIn)).toEqual([base!.snapshotId, first!.snapshotId, second!.snapshotId]);
  });

  it('CR.2: the order comes from the chain, not from the order the inventory was read in', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);
    // Listing the inventory newest-first changes nothing: the walk starts at the target
    // and collects parents, so the delivered order is genealogy rather than storage order.
    await manager.listBackups();

    const delivered = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);

    expect(delivered.success).toBe(true);
    expect(source.deliveries[0]!.map(idIn)).toEqual(snapshots.map((s) => s.snapshotId));
  });

  it('CR.3: a whole-capture source is handed the newest artefact alone', async () => {
    const source = wholeSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const result = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);

    expect(result.success).toBe(true);
    expect(result.artefacts).toBe(1);
    expect(source.deliveries).toHaveLength(1);
    expect(source.deliveries[0]!.map(idIn)).toEqual([snapshots[2]!.snapshotId]);
    // And the tree it restored is the newest capture, which is a whole copy.
    expect(readdirSync(dataDir).sort()).toEqual(['second.bin', 'table.bin', 'third.bin']);
  });

  it('CR.4: a source that declares neither is refused by name, and the engine is not touched', async () => {
    const source = plainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const three = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);
    expect(three.success).toBe(false);
    expect(three.error).toBe(
      `snapshot ${snapshots[2]!.snapshotId} needs 3 artefacts to replay and source "recording" ` +
        'can neither replay a chain nor declare itself whole',
    );

    // Two links is enough: one delta is a fragment already.
    const two = await manager.restoreFromSnapshot(snapshots[1]!.snapshotId);
    expect(two.success).toBe(false);
    expect(two.error).toMatch(/^snapshot \S+ needs 2 artefacts to replay and source "recording"/);

    // The refusal precedes the work, so it costs nothing: no delivery, no staging, and the
    // duration is elapsed time rather than a clock reading added to a start time.
    expect(three.durationMs).toBeGreaterThanOrEqual(0);
    expect(three.durationMs).toBeLessThan(5000);
    expect(source.deliveries).toEqual([]);
    expect(readdirSync(root).filter((name) => name.endsWith('.restore.artifact'))).toEqual([]);
  });

  it('CR.5: a chain-capable source is handed a chain even when it holds one artefact', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const base = (await manager.createBackup({ type: 'full' })).snapshot!;

    const result = await manager.restoreFromSnapshot(base.snapshotId);

    expect(result.success).toBe(true);
    expect(result.artefacts).toBe(1);
    // The shape of the call does not vary with the length: a chain source is always given
    // a chain, so it never has to ask which of the two it received.
    expect(source.restoreChain).toBeDefined();
    expect(source.deliveries).toHaveLength(1);
    expect(source.deliveries[0]!).toHaveLength(1);
  });

  it('CR.6: `whole` wins when a source declares both', async () => {
    const source = chainSource();
    source.whole = true;
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const result = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);

    expect(result.success).toBe(true);
    expect(result.artefacts).toBe(1);
    expect(source.deliveries[0]!.map(idIn)).toEqual([snapshots[2]!.snapshotId]);
  });

  it('CR.7: a damaged link in the middle is refused by name, before the engine', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    // Same length, different bytes: only the digest can see this, and it is the middle
    // link's digest — the one a single-artefact restore never looked at.
    const staged = join(root, 'corrupt');
    await storage.download(snapshots[1]!.location, staged);
    const bytes = readFileSync(staged);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(staged, bytes);
    await storage.upload(staged, snapshots[1]!.location);

    const result = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      new RegExp(`^the artefact of ${snapshots[1]!.snapshotId} does not match the snapshot's digest`),
    );
    expect(source.deliveries).toEqual([]);
  });

  it('CR.8: skipVerification skips every link’s digest and still refuses a wrong size', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const staged = join(root, 'corrupt');
    await storage.download(snapshots[0]!.location, staged);
    const bytes = readFileSync(staged);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(staged, bytes);
    await storage.upload(staged, snapshots[0]!.location);

    const skipped = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId, { skipVerification: true });
    expect(skipped.success).toBe(true);
    expect(skipped.artefacts).toBe(3);

    const shortened = join(root, 'short');
    await storage.download(snapshots[1]!.location, shortened);
    writeFileSync(shortened, readFileSync(shortened).subarray(0, 4));
    await storage.upload(shortened, snapshots[1]!.location);

    const refused = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId, { skipVerification: true });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(new RegExp(`^the artefact of ${snapshots[1]!.snapshotId} is 4 bytes`));
  });

  it('CR.9: a chain that cannot be replayed is refused before a single download', async () => {
    const downloads: string[] = [];
    const backend = passthrough({
      download: async (key: string, destination: string) => {
        downloads.push(key);
        await storage.download(key, destination);
      },
    });
    const source = chainSource();
    const manager = managerOver(source, backend);
    const [base, , second] = await chainOfThree(manager);

    // The base's record goes and its artefact stays: the inventory no longer names it, so
    // the chain has a hole — the state `unrestorableReason` exists to report.
    await storage.delete(inventoryKey('backups', base!.snapshotId));

    const result = await manager.restoreFromSnapshot(second!.snapshotId);

    expect(result.success).toBe(false);
    expect(result.error).toBe(`base snapshot ${base!.snapshotId} of incremental ${second!.snapshotId} is missing`);
    expect(downloads).toEqual([]);
    expect(source.deliveries).toEqual([]);
  });

  it('CR.10: an engine that rejects the chain is a failure, not a partial success', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);
    source.failWith = 'the engine refused the second delta';

    const result = await manager.restoreFromSnapshot(snapshots[2]!.snapshotId);

    expect(result.success).toBe(false);
    expect(result.error).toBe('the engine refused the second delta');
    expect(result.artefacts).toBeUndefined();
    // It was handed the whole chain: a source rebuilding from a partial chain is the
    // source's own decision, made with the whole list in hand.
    expect(source.deliveries[0]).toHaveLength(3);
  });

  it('CR.11: staging files do not survive a success, a refusal or a rejection', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const staged = (): string[] =>
      readdirSync(workDir, { recursive: true })
        .map(String)
        .filter((n) => n.includes('restore'));

    expect((await manager.restoreFromSnapshot(snapshots[2]!.snapshotId)).success).toBe(true);
    expect(staged()).toEqual([]);

    source.failWith = 'no';
    expect((await manager.restoreFromSnapshot(snapshots[2]!.snapshotId)).success).toBe(false);
    expect(staged()).toEqual([]);

    source.failWith = null;
    // A refusal on the middle link leaves the two files it staged behind if the clean-up
    // is not a loop — which it is, and this is the case that says so.
    const corrupted = join(root, 'corrupt');
    await storage.download(snapshots[1]!.location, corrupted);
    writeFileSync(corrupted, readFileSync(corrupted).subarray(0, 4));
    await storage.upload(corrupted, snapshots[1]!.location);
    expect((await manager.restoreFromSnapshot(snapshots[2]!.snapshotId)).success).toBe(false);
    expect(staged()).toEqual([]);
  });

  it('CR.12: pitr reaches the same replay, by id and by time', async () => {
    const source = chainSource();
    const manager = managerOver(source);
    const snapshots = await chainOfThree(manager);

    const byId = await manager.pitr({ snapshotId: snapshots[2]!.snapshotId });
    expect(byId.success).toBe(true);
    expect(byId.artefacts).toBe(3);

    const byTime = await manager.pitr({ targetTime: new Date(Date.now() + 1000).toISOString() });
    expect(byTime.success).toBe(true);
    expect(byTime.recoveryPoint).toBe(snapshots[2]!.snapshotId);
    // Two restores, two chains: the replay is in `restoreFromSnapshot`, not in a caller.
    expect(source.deliveries).toHaveLength(2);
    expect(source.deliveries[1]!.map(idIn)).toEqual(snapshots.map((s) => s.snapshotId));
  });

  it('CR.17: snapshots sharing a timestamp are ranked by depth, so the head is the recovery point', async () => {
    // One instant for all three: `createBackup` stamps `createdAt` from this clock, so the
    // timestamps tie and the choice has to come from something else. Depth — three
    // artefacts to replay the head, one to replay the base — is that something; a plain
    // sort by time would keep the listing's order and hand back the base.
    const fixed = (): Date => new Date('2026-05-01T00:00:00.000Z');
    const source = chainSource();
    const manager = new BackupManager(
      source,
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir, clock: fixed },
    );
    const snapshots = await chainOfThree(manager);
    expect(new Set(snapshots.map((s) => s.createdAt)).size).toBe(1);

    const result = await manager.pitr({ targetTime: '2026-05-02T00:00:00.000Z' });

    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe(snapshots[2]!.snapshotId);
    expect(result.artefacts).toBe(3);
  });

  it('CR.18: the recovery point does not depend on the order the bucket listed', async () => {
    // Two fulls at the same instant: neither is above the other, so depth ties and the id
    // is what decides. A backend that lists newest-first, as a real one may, must not
    // change the answer — which is the property, not the tie-break, that matters.
    const fixed = (): Date => new Date('2026-06-01T00:00:00.000Z');
    const writer = new BackupManager(
      plainSource(),
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir, clock: fixed },
    );
    const first = (await writer.createBackup({ type: 'full' })).snapshot!;
    const second = (await writer.createBackup({ type: 'full' })).snapshot!;
    expect(first.createdAt).toBe(second.createdAt);

    const straight = new BackupManager(
      plainSource(),
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir, clock: fixed },
    );
    const backwards = new BackupManager(
      plainSource(),
      passthrough({ list: async (prefix) => (await storage.list(prefix)).reverse() }),
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir, clock: fixed },
    );

    const target = { targetTime: '2026-07-01T00:00:00.000Z' };
    const a = await straight.pitr(target);
    const b = await backwards.pitr(target);

    expect(a.success).toBe(true);
    expect(a.recoveryPoint).toBe(b.recoveryPoint);
    expect([first.snapshotId, second.snapshotId]).toContain(a.recoveryPoint);
  });
});

describe('AC 102 — resolveChain, the walk the check and the replay share', () => {
  /** Metadata shaped for a chain, with only the fields the walk reads. */
  function snapshot(id: string, parent: string | undefined, type: BackupMetadata['type']): BackupMetadata {
    return {
      snapshotId: id,
      type,
      state: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      sizeBytes: 1,
      fileCount: 1,
      location: `backups/${id}.artifact`,
      ...(parent === undefined ? {} : { parentSnapshotId: parent }),
    };
  }

  function inventory(...snapshots: BackupMetadata[]): Map<string, BackupMetadata> {
    return new Map(snapshots.map((s) => [s.snapshotId, s]));
  }

  it('CR.13: one walk answers the chain and the reason', () => {
    const base = snapshot('base', undefined, 'full');
    const one = snapshot('one', 'base', 'incremental');
    const two = snapshot('two', 'one', 'incremental');
    const table = inventory(base, one, two);

    // A base needs only itself, and the list is the chain oldest-first.
    expect(resolveChain(table, base)).toEqual({ chain: [base], reason: null });
    expect(resolveChain(table, two)).toEqual({ chain: [base, one, two], reason: null });
    // The reason is null exactly when the chain is non-empty: a caller cannot get one
    // without the other, which is what keeps the check and the replay in step.
    expect(resolveChain(table, two).reason).toBeNull();
  });

  it('CR.14: resolveChain refuses a cycle, a missing base and a delta with no root', () => {
    const loopA = snapshot('loop-a', 'loop-b', 'incremental');
    const loopB = snapshot('loop-b', 'loop-a', 'incremental');
    const orphan = snapshot('orphan', 'gone', 'incremental');
    const rootless = snapshot('rootless', undefined, 'incremental');
    const table = inventory(loopA, loopB, orphan, rootless);

    // The cycle is reported as the link that repeats, which from `loop-a` is `loop-a`
    // itself: its parent `loop-b` names it back.
    expect(resolveChain(table, loopA)).toEqual({
      chain: [],
      reason: 'parent chain of snapshot loop-a is cyclic at loop-a',
    });
    expect(resolveChain(table, loopB)).toEqual({
      chain: [],
      reason: 'parent chain of snapshot loop-b is cyclic at loop-b',
    });
    expect(resolveChain(table, orphan)).toEqual({
      chain: [],
      reason: 'base snapshot gone of incremental orphan is missing',
    });
    expect(resolveChain(table, rootless)).toEqual({
      chain: [],
      reason: 'incremental snapshot rootless has no full snapshot at the root of its chain',
    });
  });
});

describe('AC 102 — a real delta engine', () => {
  /**
   * A source that captures only what changed, and can rebuild from the whole chain.
   *
   * `capture` writes one entry per file whose contents differ from the previous capture,
   * so the second and third artefacts hold one file each. `restore` replaces the
   * directory with the single artefact it is given — the fragment — and `restoreChain`
   * clears the directory and applies every artefact in order. The point of having both is
   * that the difference between them is the bug this iteration fixes.
   */
  class DeltaDirectorySource implements IBackupSource {
    readonly name = 'delta-directory';
    private readonly known = new Map<string, string>();

    constructor(private readonly directory: string) {}

    async capture(destination: string): Promise<SnapshotCapture> {
      const entries: Array<{ name: string; text: string }> = [];
      for (const name of readdirSync(this.directory).sort()) {
        const text = readFileSync(join(this.directory, name), 'utf8');
        if (this.known.get(name) === text) continue;
        entries.push({ name, text });
        this.known.set(name, text);
      }
      const body = JSON.stringify({ entries });
      writeFileSync(destination, body);
      return { bytes: Buffer.byteLength(body), files: entries.length };
    }

    async restore(source: string): Promise<void> {
      this.replaceWith(source);
    }

    async restoreChain(chain: readonly string[]): Promise<void> {
      rmSync(this.directory, { recursive: true, force: true });
      mkdirSync(this.directory, { recursive: true });
      for (const source of chain) this.apply(source);
    }

    private replaceWith(source: string): void {
      rmSync(this.directory, { recursive: true, force: true });
      mkdirSync(this.directory, { recursive: true });
      this.apply(source);
    }

    private apply(source: string): void {
      const { entries } = JSON.parse(readFileSync(source, 'utf8')) as {
        entries: Array<{ name: string; text: string }>;
      };
      for (const entry of entries) writeFileSync(join(this.directory, entry.name), entry.text);
    }
  }

  it('CR.15: three deltas of one file each restore into all three files', async () => {
    const source = new DeltaDirectorySource(dataDir);
    const manager = new BackupManager(
      source,
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const base = (await manager.createBackup({ type: 'full' })).snapshot!;
    writeFileSync(join(dataDir, 'second.bin'), 'beta-rows');
    const first = (await manager.createBackup({ type: 'incremental' })).snapshot!;
    writeFileSync(join(dataDir, 'third.bin'), 'gamma-rows');
    const second = (await manager.createBackup({ type: 'incremental' })).snapshot!;

    // The two deltas really are deltas: one file each, and neither holds the base's file.
    // Delivering only the newest would therefore leave a directory with one file in it and
    // report success — the fragment the old code produced.
    expect(first.fileCount).toBe(1);
    expect(second.fileCount).toBe(1);

    // The engine is lost.
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });

    const result = await manager.restoreFromSnapshot(second.snapshotId);

    expect(result.success).toBe(true);
    expect(result.artefacts).toBe(3);
    expect(readdirSync(dataDir).sort()).toEqual(['second.bin', 'table.bin', 'third.bin']);
    expect(readFileSync(join(dataDir, 'table.bin'), 'utf8')).toBe('alpha-rows');
    expect(readFileSync(join(dataDir, 'third.bin'), 'utf8')).toBe('gamma-rows');
    expect(base.fileCount).toBe(1);
  });

  it('CR.16: the fragment is real — restoring the newest delta alone leaves one file', async () => {
    const source = new DeltaDirectorySource(dataDir);
    const manager = new BackupManager(
      source,
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    await manager.createBackup({ type: 'full' });
    writeFileSync(join(dataDir, 'second.bin'), 'beta-rows');
    await manager.createBackup({ type: 'incremental' });
    writeFileSync(join(dataDir, 'third.bin'), 'gamma-rows');
    const second = (await manager.createBackup({ type: 'incremental' })).snapshot!;

    // What the port's single-artefact `restore` does with a delta, called directly: this is
    // the state the manager would have produced for a source like this one before the chain
    // was replayed, and the reason a refusal is better than a success.
    const staged = join(root, 'delta-alone');
    await storage.download(second.location, staged);
    await source.restore(staged);

    expect(readdirSync(dataDir)).toEqual(['third.bin']);
  });
});
