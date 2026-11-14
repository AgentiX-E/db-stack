/**
 * GraphVecFederationConsumer — db-federation ↔ graphvec-db adapter stub.
 *
 * graphvec-db uses ConsensusProvider + OutboxReplicationManager
 * for its multi-leader replication. This adapter wraps that pattern
 * into the IFederationConsumer interface.
 *
 * In Phase 4, this is a structural adapter — it translates between
 * the federation layer's ReplicatedEntry/ConflictEntry types and
 * graphvec-db's internal types.
 *
 * AC 46.6 — GraphVecFederationConsumer integrates with graphvec-db
 *
 * Note: graphvec-db's ConsensusProvider and OutboxReplicationManager
 * are defined in graphvec-db's source tree (not available in db-cluster).
 * This adapter provides the interface contract and a reference
 * implementation for the bridge logic.
 */

import type { IFederationConsumer, ReplicatedEntry, ConflictEntry } from '../core/FederationManager';
import { HLC } from '../hlc/HLC';

/**
 * The minimal interface that graphvec-db must expose for federation.
 * In production, graphvec-db's ConsensusProvider implements this.
 */
export interface IGraphVecConsensusProvider {
  /** Propose a value for consensus within a shard */
  propose(shardId: string, value: string): Promise<number>;
  /** Get local leader status for a shard */
  isLeader(shardId: string): boolean;
}

export interface GraphVecFederationConsumerConfig {
  /** graphvec-db consensus provider (or adapter) */
  consensusProvider: IGraphVecConsensusProvider;
  /** HLC instance */
  hlc: HLC;
  /** Local DC */
  dc: string;
  /** Local node ID */
  nodeId: string;
}

export class GraphVecFederationConsumer implements IFederationConsumer {
  private readonly config: GraphVecFederationConsumerConfig;

  constructor(config: GraphVecFederationConsumerConfig) {
    this.config = config;
  }

  /**
   * AC 46.6:
   * Propose a replicated entry from a remote DC into graphvec-db's
   * consensus layer. Uses the HLC timestamp from the source for
   * causal ordering.
   */
  async proposeReplicated(entry: ReplicatedEntry): Promise<void> {
    // Observe remote HLC for causal ordering
    this.config.hlc.observe(entry.hlcTimestamp);

    // Build the payload with federation metadata
    const payload = JSON.stringify({
      __federation: true,
      sourceDc: entry.sourceDc,
      sourceNodeId: entry.sourceNodeId,
      data: entry.data,
      type: entry.type,
    });

    await this.config.consensusProvider.propose('federation', payload);
  }

  getHLC(): HLC {
    return this.config.hlc;
  }

  async onConflict(conflict: ConflictEntry): Promise<void> {
    const payload = JSON.stringify({
      __federation: true,
      __conflict: true,
      key: conflict.key,
    });

    await this.config.consensusProvider.propose('federation', payload);
  }
}
