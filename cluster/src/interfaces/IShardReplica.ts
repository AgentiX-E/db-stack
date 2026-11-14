/**
 * IShardReplica — Interface for a shard state machine that Raft applies entries to.
 */
export interface ApplyEntry {
  index: number;
  term: number;
  command: string;
  data: Buffer | string;
  /** PITR messaging identifier */
  msgId?: string;
  /** PITR operation type */
  type?: string;
}

export interface IShardReplica {
  apply(entry: ApplyEntry): Promise<void>;
  getAppliedIndex(): Promise<number>;
  lastAppliedIndex(): number;
  shardId(): number;
  snapshot(): Promise<Buffer>;
  restore(snapshot: Buffer): Promise<void>;
  dataSize(): Promise<number>;
}
