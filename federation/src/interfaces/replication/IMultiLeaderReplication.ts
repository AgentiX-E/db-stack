import type { RetentionWindows } from '../../storage/retention';
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
  /**
   * What counts as a delivery.
   *
   * `'peer'` (the default) means the receiving node confirmed it applied the
   * change, and an outbox entry is retired on that confirmation rather than on
   * `ITransport.send()` resolving. That resolution is a statement about this
   * node's socket: a TCP write into a connection whose peer has already gone is
   * accepted by the local kernel, so a sender that retires on it reports a
   * delivery the peer never made. An acceptance run measured the gap — twenty
   * changes reported delivered, thirteen applied, no refusal, no dead letter.
   *
   * `'none'` is the weaker contract, chosen explicitly: the transport's answer is
   * the delivery. It is the right shape for a peer that cannot answer, and it is
   * still at-least-once onto the wire.
   */
  acknowledgement?: 'peer' | 'none';
  /**
   * How long one confirmation is waited for, in milliseconds. Default 5 000.
   *
   * Ignored when `acknowledgement` is `'none'`. A wait that expires is a failed
   * attempt, not a lost entry: the entry keeps its place and the retry budget
   * decides when it becomes a dead letter with a reason.
   */
  ackTimeoutMs?: number;
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

  /**
   * The retention windows of the outbox this replication sends from.
   *
   * The replication is the only object that knows how long it will keep
   * retrying an entry, so it is the only object a receiver can ask before it
   * decides how long to remember a message id. Required rather than optional:
   * an implementation that cannot answer is an implementation whose peer has to
   * guess, and a guess that is too short is a duplicate change.
   */
  getRetention(): RetentionWindows;
}
