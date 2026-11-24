import type { IHLCTimestamp } from '../hlc/IHLCTimestamp';
import type { OutboxEntry } from '../outbox/OutboxEntry';

export type TopologyType = 'intra-dc' | 'cross-dc' | 'edge';

export interface ReplicationTarget {
  nodeId: string;
  dc: string;
  address: string;
  topology: TopologyType;
  /** Backoff strategy for this target: intra-dc=3s, cross-dc=60s, edge=300s */
  maxBackoffSeconds: number;
}

export interface ReplicationConfig {
  nodeId: string;
  dc: string;
  targets: ReplicationTarget[];
  curveDir: string;
  tickMs?: number;
  batchSize?: number;
  maxRetries?: number;
}

export interface ReplicationStatus {
  nodeId: string;
  dc: string;
  targets: Array<{
    targetNodeId: string;
    connected: boolean;
    lagMs: number;
    pendingCount: number;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    lastErrorMessage: string | null;
  }>;
}

export interface IMultiLeaderReplication {
  start(config: ReplicationConfig): Promise<void>;
  stop(): Promise<void>;

  /**
   * Replicate data to all targets (write to Outbox + async send).
   * `type` defaults to `'replicate'` when omitted.
   */
  replicate(shardId: number, data: string, type?: string): Promise<{ msgId: string }>;

  /** Get replication status for all targets */
  getStatus(): Promise<ReplicationStatus>;

  /** Force retry failed entries for a specific target */
  retryFailed(targetNodeId: string): Promise<number>;

  /** Get pending count for all targets */
  getPendingCounts(): Promise<Record<string, number>>;

  /** Event: fires when a target connects */
  onTargetConnected(callback: (targetNodeId: string) => void): () => void;

  /** Event: fires when a target disconnects */
  onTargetDisconnected(callback: (targetNodeId: string) => void): () => void;

  /**
   * Event: fires when a target that had been failing delivers again.
   *
   * Distinct from `onTargetConnected`, which fires once when the worker is
   * created: a target can be connected and failing at the same time, and the
   * transition that matters for a dead letter queue is "it works again".
   */
  onTargetRecovered(callback: (targetNodeId: string) => void): () => void;

  /**
   * Whether the transport currently holds a link to a target.
   *
   * Recovery evidence that survives an empty queue — see `onTargetRecovered`.
   */
  isPeerReachable(targetNodeId: string): boolean;

  /** Event: fires when replication lag exceeds threshold */
  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void;
}
