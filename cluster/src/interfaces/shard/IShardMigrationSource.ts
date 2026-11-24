/**
 * The read side of a shard migration.
 *
 * A migration is a copy, and a copy needs a source that can be enumerated. The
 * coordinator in `shard/OnlineShardMigration` was written against no source at
 * all: it guessed a byte count between ten and sixty megabytes, advanced
 * `bytesCopied` by a batch size, and added a random delta for "catch-up", so
 * every number it reported was about itself. This interface is the thing it was
 * missing — and it is deliberately small, because a database engine that can
 * answer these four questions can be migrated by this coordinator without the
 * coordinator knowing what the engine is.
 *
 * The unit of enumeration is a **version**, not a cursor. A shard assigns each
 * write a monotonically increasing version; a catch-up pass asks for everything
 * above the watermark the first pass reached. That is the only shape that
 * survives concurrent writes without the coordinator holding a lock across the
 * copy: a page-by-page scan with an offset would re-read or skip entries as the
 * pages shift underneath it.
 *
 * @module @agentix-e/db-cluster/interfaces/shard
 */

/** One entry as a shard holds it, without the value. */
export interface ShardScanEntry {
  /** The entry's key, unique within the shard. */
  key: string;
  /**
   * Bytes the entry occupies in the source, by the source's own measure.
   *
   * Used for the byte counters the status reports. A source that cannot measure
   * cheaply may report the value length; a source that reports zero makes the
   * byte counters agree with the entry counters, which is honest and still not
   * a simulation.
   */
  bytes: number;
  /** The version the shard assigned to this entry's latest write. */
  version: number;
}

/** What a shard holds, in one answer. */
export interface ShardVolumeStats {
  /** Number of entries the shard currently holds. */
  entries: number;
  /** Total bytes those entries occupy, by the shard's own measure. */
  bytes: number;
}

/** A shard a migration can read. */
export interface IShardMigrationSource {
  /** Entries and bytes the shard holds right now. */
  stats(shardId: number): Promise<ShardVolumeStats>;
  /**
   * At most `limit` entries whose version is **strictly greater** than
   * `afterVersion`, in ascending version order.
   *
   * An empty answer means "nothing above the watermark", which is how a
   * catch-up pass decides it is done. The order is part of the contract: the
   * caller uses the last entry's version as the next watermark, so a source that
   * returns entries out of order makes the coordinator skip the ones in between.
   */
  scanEntries(shardId: number, afterVersion: number, limit: number): Promise<ShardScanEntry[]>;
  /**
   * The entry's current value, or `undefined` if it was deleted after the scan
   * that listed it.
   *
   * A deletion between the scan and the read is not an error: the coordinator
   * counts it as reconciled and leaves it out of the copy, because a shard that
   * lost a key while being copied is a shard whose key should not arrive.
   */
  readEntry(shardId: number, key: string): Promise<{ key: string; value: string; version: number } | undefined>;
  /**
   * The highest version the shard has assigned, or `0` when it holds nothing.
   *
   * Taken at the moment the initial pass ends: everything at or below it is
   * either copied or was deleted, so the catch-up begins above it and never
   * re-reads the first pass's work.
   */
  currentVersion(shardId: number): Promise<number>;
}
