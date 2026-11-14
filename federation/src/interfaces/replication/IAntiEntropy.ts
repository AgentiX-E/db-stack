export interface AntiEntropyConfig {
  nodeId: string;
  intervalMs: number;
  merkleDepth: number;
}

export interface SyncResult {
  nodeId: string;
  entriesSynced: number;
  entriesSkipped: number;
  conflictsResolved: number;
  durationMs: number;
  completedAt: number;
}

export interface IAntiEntropy {
  start(config: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  /** Trigger an immediate sync with a specific peer */
  syncWith(peerNodeId: string): Promise<SyncResult>;
  /** Trigger a full cluster sync */
  syncAll(): Promise<SyncResult[]>;
  /** Get the Merkle tree root hash for a shard */
  getMerkleRoot(shardId: string): Promise<string>;
}
