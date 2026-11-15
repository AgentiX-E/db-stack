/**
 * A committed Raft entry handed to the outbox for asynchronous fan-out.
 * This is the payload RaftGroup builds after a successful commit.
 */
export interface OutboxRecord {
  /** Stable message id for de-duplication downstream */
  msgId: string;
  /** Raft log index the entry committed at */
  raftIndex: number;
  /** Raft term the entry committed in */
  raftTerm: number;
  /** Shard the entry belongs to */
  shardId: number;
  /** Target data centre, '*' for fan-out to all */
  targetDC: string;
  /** Operation type carried by the entry */
  type: string;
  /** Serialised operation payload */
  payload: string | Buffer;
  /** Commit timestamp (epoch ms) */
  createdAt: number;
}

/**
 * IOutboxWriter — Interface for writing committed Raft entries to the outbox.
 * Bridges the consensus layer to the replication/outbox system.
 *
 * RaftGroup appends every committed entry here (single and batched), so
 * `append`/`appendBatch` are the contract the consensus layer actually uses.
 */
export interface IOutboxWriter {
  /** Append a single committed entry to the outbox. */
  append(record: OutboxRecord): void | Promise<void>;
  /** Append a batch of committed entries to the outbox. */
  appendBatch(records: OutboxRecord[]): void | Promise<void>;
  write(shardId: string, index: number, term: number, data: string): Promise<void>;
  getLastWrittenIndex(shardId: string): Promise<number>;
}
