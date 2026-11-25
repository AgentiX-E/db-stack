export interface AntiEntropyConfig {
  nodeId: string;
  intervalMs: number;
  merkleDepth: number;
}

/** One bucket of the key space, as a digest reports it. */
export interface DigestLeaf {
  /** Binary prefix of `SHA-256(key)` naming this bucket; length is the digest depth. */
  prefix: string;
  /** Hash of the bucket's contents, or the shared empty-bucket constant. */
  hash: string;
  /** Entries in the bucket, so a peer can tell "same size, different contents" from "absent". */
  count: number;
}

/**
 * What one node claims its dataset looks like.
 *
 * Comparable with another node's digest built at the same depth — that is the
 * whole point of naming every bucket by a function of the key rather than by a
 * function of the entries the node happens to hold.
 */
export interface DatasetDigest {
  shardId: string;
  /** Bucket count as a power of two: the digest carries `2^depth` leaves. */
  depth: number;
  /** Root over all buckets. Equal roots mean equal datasets at this depth. */
  root: string;
  /** Total entries, so a page can say "same root, 0 entries" without walking it. */
  total: number;
  leaves: DigestLeaf[];
}

export interface SyncResult {
  nodeId: string;
  /** Entries this node took from the peer and applied. */
  entriesSynced: number;
  /** Entries the peer pushed that this node already held at least as new. */
  entriesSkipped: number;
  /** Entries where the two clocks disagreed and one side lost. */
  conflictsResolved: number;
  /** Entries this node handed to the peer. */
  pushed: number;
  /**
   * False when the digest round trip did not complete.
   *
   * Separate from a zero result on purpose: "the peer is down" and "the peer
   * agrees with me" are the two states an operator most needs to distinguish, and
   * both would otherwise report `entriesSynced: 0`.
   */
  peerReachable: boolean;
  durationMs: number;
  completedAt: number;
}

export interface IAntiEntropy {
  start(config: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  /** Trigger an immediate sync with a specific peer */
  syncWith(peerNodeId: string, shardId?: string): Promise<SyncResult>;
  /** Trigger a full cluster sync */
  syncAll(shardId?: string): Promise<SyncResult[]>;
  /** Get the Merkle tree root hash for a shard */
  getMerkleRoot(shardId: string): Promise<string>;
}
