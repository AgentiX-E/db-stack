/**
 * In-memory shard for the migration tests.
 *
 * Not a mock: it is a small store that answers the two interfaces exactly as an
 * engine would — entries carry the version of their latest write, a scan returns
 * what is above a watermark in ascending version order, and the target counts
 * what it actually holds. The coordinator's job is to reconcile two of these, so
 * a fixture that guessed its own answers would be testing the guess.
 *
 * Two hooks exist because a migration's hard cases are about timing and loss, and
 * neither can be expressed by a static table:
 *
 *   `onScan`   runs after every scan, which is where a concurrent writer's entry
 *              lands — the write that arrives between two pages of the copy.
 *   `dropKeys` makes the target refuse a key, which is how the conservation check
 *              is shown to be a check rather than a formality.
 */

import type { IShardMigrationSink } from '../../interfaces/shard/IShardMigrationSink';
import type {
  IShardMigrationSource,
  ShardScanEntry,
  ShardVolumeStats,
} from '../../interfaces/shard/IShardMigrationSource';

interface StoredEntry {
  value: string;
  version: number;
}

/** The entries a shard holds, with the version counter that orders them. */
export class MemoryStore {
  private readonly entries = new Map<string, StoredEntry>();
  private counter = 0;

  /**
   * Store an entry, at `version` when one is given.
   *
   * A migrated entry keeps the version the source assigned: the version is the
   * entry's position in the log, and a sink that renumbered its input would make
   * every retry look like a new write.
   */
  put(key: string, value: string, version?: number): number {
    const assigned = version ?? this.counter + 1;
    this.counter = Math.max(this.counter, assigned);
    this.entries.set(key, { value, version: assigned });
    return assigned;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get(key: string): StoredEntry | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  get version(): number {
    return this.counter;
  }

  /** Entries in ascending version order — the order a scan must return. */
  ordered(): Array<{ key: string } & StoredEntry> {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => a.version - b.version);
  }

  bytes(): number {
    let total = 0;
    for (const { key, value } of this.ordered()) total += Buffer.byteLength(key) + Buffer.byteLength(value);
    return total;
  }
}

/** The read side: a shard a migration copies from. */
export class MemoryShardSource implements IShardMigrationSource {
  readonly store: MemoryStore;
  /**
   * Runs after every scan, and is awaited — the seam a concurrent writer uses, and
   * the place a test holds the copy still to observe a phase in progress.
   */
  onScan?: (shardId: number, afterVersion: number) => void | Promise<void>;
  /**
   * Awaited at the start of every scan.
   *
   * A test holds this to keep a migration inside a phase it wants to observe —
   * an active migration, a copy in flight — instead of sleeping and hoping the
   * loop is where the assertion needs it.
   */
  pending?: Promise<void>;
  scanCalls = 0;

  constructor(store: MemoryStore = new MemoryStore()) {
    this.store = store;
  }

  async stats(): Promise<ShardVolumeStats> {
    return { entries: this.store.size, bytes: this.store.bytes() };
  }

  async scanEntries(shardId: number, afterVersion: number, limit: number): Promise<ShardScanEntry[]> {
    this.scanCalls += 1;
    if (this.pending !== undefined) await this.pending;
    const page = this.store
      .ordered()
      .filter((entry) => entry.version > afterVersion)
      .slice(0, limit)
      .map((entry) => ({
        key: entry.key,
        bytes: Buffer.byteLength(entry.key) + Buffer.byteLength(entry.value),
        version: entry.version,
      }));
    await this.onScan?.(shardId, afterVersion);
    return page;
  }

  async readEntry(_shardId: number, key: string): Promise<{ key: string; value: string; version: number } | undefined> {
    const entry = this.store.get(key);
    return entry === undefined ? undefined : { key, value: entry.value, version: entry.version };
  }

  async currentVersion(): Promise<number> {
    return this.store.version;
  }
}

/** The write side: the node that will own the shard, per target name. */
export class MemoryShardSink implements IShardMigrationSink {
  private readonly targets = new Map<string, MemoryStore>();
  /** Keys this sink refuses — a lost write, expressed as data rather than as a stub. */
  readonly dropKeys = new Set<string>();
  /**
   * Awaited inside `stats`, which the coordinator calls for the conservation check.
   *
   * A test holds this to place a command inside the last window of the run — the
   * one between the last cancellation checkpoint and completion.
   */
  statsGate?: Promise<void>;
  /** Applied entries, in the order they arrived. */
  readonly applied: Array<{ target: string; key: string; version: number }> = [];

  storeFor(target: string): MemoryStore {
    let store = this.targets.get(target);
    if (store === undefined) {
      store = new MemoryStore();
      this.targets.set(target, store);
    }
    return store;
  }

  async applyEntry(
    targetNode: string,
    _shardId: number,
    entry: { key: string; value: string; version: number },
  ): Promise<void> {
    this.applied.push({ target: targetNode, key: entry.key, version: entry.version });
    if (this.dropKeys.has(entry.key)) return;
    const store = this.storeFor(targetNode);
    // Idempotent by (key, version): a batch retried after a failure is not a
    // second write, and a sink that counted it as one would make the conservation
    // check pass by counting the same entry twice.
    const existing = store.get(entry.key);
    if (existing !== undefined && existing.version >= entry.version) return;
    store.put(entry.key, entry.value, entry.version);
  }

  async stats(targetNode: string): Promise<ShardVolumeStats> {
    if (this.statsGate !== undefined) await this.statsGate;
    const store = this.storeFor(targetNode);
    return { entries: store.size, bytes: store.bytes() };
  }
}
