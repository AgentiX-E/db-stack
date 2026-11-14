/**
 * IStorageEngine — the engine-agnostic contract between db-cluster and a
 * database engine.
 *
 * db-cluster owns consensus, sharding and durability of the *log*. It does not
 * own the data: the data belongs to whatever engine the operator already runs
 * (PostgreSQL, MySQL, an embedded KV store, a columnar store, an LSM tree the
 * team wrote in-house). This interface is the only thing an engine has to
 * implement to be replicated by db-cluster.
 *
 * ## The contract, in five rules
 *
 * 1. **Apply is exactly-once and in order.** The middleware never delivers the
 *    same `index` twice from the same engine instance, never skips an index, and
 *    never delivers two commands concurrently. An implementation may therefore
 *    be written as a straightforward state mutation — it does not need its own
 *    de-duplication, sequencing or locking.
 * 2. **Apply is all-or-nothing.** If `apply` rejects, the middleware treats the
 *    index as not applied and stops advancing. A partially applied command is a
 *    contract violation, because the entry will be re-delivered to a fresh
 *    instance after a restart.
 * 3. **`snapshot()` followed by `restore()` must reproduce the exact applied
 *    state**, including the deletion state (a restore must never resurrect a
 *    key that was deleted before the snapshot).
 * 4. **`restore()` is a replacement, not a merge.** It is called both on a
 *    brand-new instance (bootstrap from a peer's snapshot) and on a running
 *    instance (catching up after falling behind).
 * 5. **`query()` is side-effect free.** It is called on the leader for
 *    read-your-writes reads and may be called concurrently with `apply` once the
 *    engine is exposed for reads; an implementation that needs a consistent view
 *    takes its own lock.
 *
 * Everything else — storage format, schema, indexing, whether a command is SQL
 * or a binary opcode — is invisible to the middleware: `apply` receives opaque
 * bytes that the engine's own encoder produced.
 *
 * @module interfaces/IStorageEngine
 */

/**
 * Metadata for one committed log entry, supplied to every `apply` call.
 *
 * The context is the answer to "which state transition is this, exactly?" — an
 * engine that wants to expose its applied index (for read-your-writes, for
 * fencing, for its own diagnostics) reads it from here rather than inventing a
 * counter, because only the middleware knows the Raft index.
 */
export interface EngineApplyContext {
  /** Shard the entry belongs to. Engines that hold several shards in one store key by it. */
  readonly shardId: number;

  /**
   * Raft log index of the entry. Exact: contiguous, gap-free, starting at 1 and
   * monotonic for the lifetime of the shard.
   */
  readonly index: number;

  /**
   * Term the node was in when it applied the entry.
   *
   * For an entry committed in the current term this equals the entry's own term;
   * for the handful of entries a new leader inherits it can be greater. Raft has
   * already ordered and de-duplicated by the time this is delivered, so the value
   * is diagnostic metadata — never a correctness input.
   */
  readonly applyTerm: number;

  /** Operation discriminator carried in the committed envelope, when the writer set one. */
  readonly operation?: string;

  /** Point-in-time-recovery message identifier, when the writer set one. */
  readonly msgId?: string;
}

/**
 * The storage engine SPI.
 *
 * Implementations must be safe to construct before the cluster is ready; the
 * middleware calls `apply`/`query`/`snapshot`/`restore` only after `open()` (if
 * provided) has resolved.
 */
export interface IStorageEngine {
  /** Stable identifier used in logs, metrics and conformance reports. */
  readonly name: string;

  /**
   * Apply one committed command to the engine's state.
   *
   * @param context Position of the entry in the replicated log.
   * @param payload Opaque bytes produced by the engine's own encoder.
   */
  apply(context: EngineApplyContext, payload: Buffer): Promise<void>;

  /**
   * Evaluate a read against applied state.
   *
   * @param request Opaque request bytes, encoded by the caller.
   * @returns The engine's encoded response.
   */
  query(request: Buffer): Promise<Buffer>;

  /**
   * Serialize the entire applied state.
   *
   * The bytes are handed to `restore()` on the same or another node, possibly on
   * a different platform, so the encoding must be self-describing and free of
   * pointers, host byte order or object identity. Determinism is not required by
   * the Raft protocol, but it is required by the conformance suite: two snapshots
   * of an unchanged state must be byte-identical, because that is what makes
   * "did this write change anything?" answerable.
   */
  snapshot(): Promise<Buffer>;

  /**
   * Replace the entire applied state with `snapshot`.
   *
   * Must validate before mutating: a rejected `restore` leaves the previous state
   * intact, so a corrupt snapshot from a peer cannot destroy a healthy replica.
   */
  restore(snapshot: Buffer): Promise<void>;

  /**
   * Live state size in bytes, used by compaction and capacity reporting.
   *
   * An estimate is acceptable; `0` must mean "no data" rather than "unknown".
   */
  sizeInBytes(): Promise<number>;

  /**
   * Release resources. Must be idempotent: the middleware closes an engine on
   * shutdown and again if initialisation fails halfway.
   */
  close(): Promise<void>;
}
