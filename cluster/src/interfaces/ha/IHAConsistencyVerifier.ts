export interface IVerificationResult {
  shardId: string;
  verified: boolean;
  lastVerifiedAt: number;
  checksum: string;
  logIndex: number;
  mismatches: Array<{
    nodeId: string;
    expectedChecksum: string;
    actualChecksum: string;
  }>;
}

export interface IHAConsistencyVerifier {
  /** Verify a shard's data across all replicas */
  verifyShard(shardId: string): Promise<IVerificationResult>;
  /** Verify all shards across all replicas */
  verifyAll(): Promise<IVerificationResult[]>;
  /** Schedule periodic verification */
  startPeriodicVerification(intervalMs: number): void;
  /** Stop periodic verification */
  stopPeriodicVerification(): void;
  /** Event: fires when inconsistency is detected */
  onInconsistency(callback: (result: IVerificationResult) => void): () => void;
}
