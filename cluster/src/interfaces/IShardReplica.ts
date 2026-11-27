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
  /**
   * The quorum position that authorised this write, in the wire form
   * `term/index`. Stamped by the consensus layer on every proposal, so an engine
   * can hand it to its own resource guard without knowing anything about Raft.
   * An engine-agnostic field: any storage implementation can carry it through to
   * the thing it writes, and ignore it if it has no fence.
   */
  fencingToken?: string;
}

export interface IShardReplica {
  apply(entry: ApplyEntry): Promise<void>;
  getAppliedIndex(): Promise<number>;
  lastAppliedIndex(): number;
  shardId(): number;
  /**
   * Serialize the applied state.
   *
   * @param boundaryIndex The Raft log index this snapshot will be declared to
   *        cover. An implementation that frames its snapshots should record this
   *        value rather than its own watermark: raft-core applies CONFIG and NOOP
   *        entries without calling the application, so the state can legitimately
   *        sit a few indexes behind the boundary it is complete *as of*. Defaults
   *        to the replica's own watermark when omitted.
   */
  snapshot(boundaryIndex?: number): Promise<Buffer>;
  restore(snapshot: Buffer): Promise<void>;
  dataSize(): Promise<number>;
}
