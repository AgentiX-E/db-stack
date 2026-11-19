/**
 * SqlVecFederationConsumer — db-federation ↔ sqlvec-db adapter.
 *
 * Bridges FederationManager's IFederationConsumer interface with db-cluster's
 * `IConsensusLayer` + `IOutboxWriter`.
 *
 * The two interfaces are declared here rather than imported so the package keeps
 * its structural contract: any object with the same two methods works, and a
 * consumer that does not use db-cluster at all can still use this adapter. They
 * are exported under names of their own because db-cluster publishes types with
 * the same names and a reader must be able to tell which one a config field
 * expects.
 *
 * Integration flow:
 *   1. sqlvec-db writes via FederationConsensusLayer.propose() → Raft commit
 *   2. Post-commit: FederationOutboxWriter.write() creates outbox entry
 *   3. db-federation's OutboxStore captures the entry
 *   4. MultiLeaderReplication fans out to remote DCs
 *   5. Remote DC receives → proposeReplicated() re-enters Raft
 *
 * AC 46.1 — SqlVecFederationConsumer wraps FederationConsensusLayer
 * AC 46.2 — Replicated Raft entries respect HLC ordering
 * AC 46.3 — OutboxWriter integration with FederationOutboxWriter.write()
 * AC 46.4 — Propose re-entrant: remote -> propose -> outbox -> replicate
 */

import type { IFederationConsumer, ReplicatedEntry, ConflictEntry } from '../core/FederationManager';
import { HLC } from '../hlc/HLC';

/**
 * Minimal consensus layer interface consumed by SqlVecFederationConsumer.
 * Mirrors the subset of db-cluster's FederationConsensusLayer used here, avoiding
 * a hard dependency on the db-cluster package.
 */
export interface FederationConsensusLayer {
  propose(shardId: string, value: string): Promise<number>;
}

/**
 * Minimal outbox writer interface consumed by SqlVecFederationConsumer.
 * Mirrors the subset of db-cluster's FederationOutboxWriter used here.
 */
export interface FederationOutboxWriter {
  write(shardId: string, index: number, term: number, data: string): Promise<void>;
  getLastWrittenIndex(shardId: string): Promise<number>;
}

export interface SqlVecFederationConsumerConfig {
  /** The FederationConsensusLayer instance from sqlvec-db (db-cluster) */
  consensusLayer: FederationConsensusLayer;
  /** The outbox writer bridge to Raft commit index gating */
  outboxWriter: FederationOutboxWriter;
  /** An HLC instance for timestamp generation */
  hlc: HLC;
  /** Local DC/region name */
  dc: string;
  /** Local node ID */
  nodeId: string;
}

export class SqlVecFederationConsumer implements IFederationConsumer {
  private readonly config: SqlVecFederationConsumerConfig;

  constructor(config: SqlVecFederationConsumerConfig) {
    this.config = config;
  }

  /**
   * AC 46.1 / AC 46.2:
   * Propose a replicated entry from a remote DC back into the local Raft cluster.
   * The HLC timestamp from the source DC is observed to maintain causal ordering,
   * and the entry is proposed as a Raft entry for local commit.
   */
  async proposeReplicated(entry: ReplicatedEntry): Promise<void> {
    // Observe the remote HLC to maintain causal ordering (AC 46.2)
    this.config.hlc.observe(entry.hlcTimestamp);

    // Encode the replicated entry with federation metadata
    // Convert BigInt to number for JSON serialization
    const payload = JSON.stringify({
      __federation: true,
      sourceDc: entry.sourceDc,
      sourceNodeId: entry.sourceNodeId,
      hlc: {
        wallTime: Number(entry.hlcTimestamp.wallTime),
        logical: Number(entry.hlcTimestamp.logical),
        nodeId: entry.hlcTimestamp.nodeId,
      },
      data: entry.data,
      type: entry.type,
    });

    // Propose to local Raft cluster (AC 46.3)
    await this.config.consensusLayer.propose('federation', payload);
  }

  /**
   * Get the local HLC instance.
   */
  getHLC(): HLC {
    return this.config.hlc;
  }

  /**
   * AC 46.5:
   * Handle conflict notification from the federation layer.
   * LWW resolution is deterministic by HLC timestamp + nodeId.
   * In production, this would re-propose the resolved value.
   */
  async onConflict(conflict: ConflictEntry): Promise<void> {
    const payload = JSON.stringify({
      __federation: true,
      __conflict: true,
      key: conflict.key,
      localValue: conflict.localValue,
      remoteValue: conflict.remoteValue,
      resolvedBy: 'lww',
    });

    await this.config.consensusLayer.propose('federation', payload);
  }

  /**
   * AC 46.3:
   * Integrate with sqlvec-db's outbox writer to gate federation
   * entries behind the Raft commit index.
   */
  async writeToOutbox(shardId: string, raftIndex: number, raftTerm: number, data: string): Promise<void> {
    await this.config.outboxWriter.write(shardId, raftIndex, raftTerm, data);
  }
}
