/**
 * Shared type definitions for @agentix-e/db-cluster
 */

/** Roles a node can assume in a Raft consensus group */
export enum ConsensusRole {
  Follower = 'follower',
  Candidate = 'candidate',
  Leader = 'leader',
}

/** Describes a change to the cluster membership */
export interface MembershipChange {
  type: 'join' | 'leave' | 'swap';
  nodeId: string;
  address?: string;
  raftGroupId?: string;
  timestamp: number;
  /** For joint consensus: unique change identifier */
  changeId?: string;
  /** Old peer IDs in the membership transition */
  oldPeers?: number[];
  /** New peer IDs in the membership transition */
  newPeers?: number[];
}

/** A Raft log entry */
export interface LogEntry {
  index: number;
  term: number;
  command: string;
  data: unknown;
  timestamp: number;
}

/** Internal Raft protocol message */
export interface RaftMessage {
  type: 'request_vote' | 'request_vote_response' | 'append_entries' | 'append_entries_response' | 'install_snapshot';
  term: number;
  from: string;
  to: string;
  payload: unknown;
}

/** Snapshot metadata */
export interface SnapshotMeta {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  groupId: string;
}

/** Node health status */
export interface NodeHealth {
  nodeId: string;
  isAlive: boolean;
  lastHeartbeat: number;
  term: number;
  role: ConsensusRole;
}

/** Generic result wrapper for operations */
export interface OperationResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

// ============================================================
// Raft consensus types (extracted from sqlvec-db)
// ============================================================

export enum RaftConsensusPhase {
  NORMAL = 'normal',
  TRANSITIONAL = 'transitional',
  C_TRANSITIONAL = 'transitional',
  C_JOINT = 'joint',
  C_NEW = 'new',
  C_NORMAL = 'normal',
}

export interface SharedTransport {
  send(fromId: string | number, msgs: unknown[]): Promise<void>;
  register?(node: { id: number; host: string; port: number }): void;
  /** Per-shard transport wrapper (NodeTransport). */
  forShard?(
    shardId: number | string,
  ): { send(fromId: string | number, msgs: unknown[]): Promise<void> } | SharedTransport;
}

export class SqlVecError extends Error {
  constructor(
    message: string,
    public code: SqlVecErrorCode = SqlVecErrorCode.INTERNAL,
  ) {
    super(message);
    this.name = 'SqlVecError';
  }
}

export enum SqlVecErrorCode {
  OK = 0,
  INTERNAL = 1,
  NOT_FOUND = 2,
  INVALID_ARGUMENT = 3,
  ALREADY_EXISTS = 4,
  UNAVAILABLE = 5,
  UNAUTHENTICATED = 6,
  FAILED_PRECONDITION = 7,
  OUT_OF_RANGE = 8,
  UNIMPLEMENTED = 9,
  ABORTED = 10,
  RAFT_NOT_LEADER = 100,
  RAFT_CAMPAIGN_FAILED = 101,
  RAFT_TRANSFER_FAILED = 102,
  QUORUM_FAILED = 200,
  // compat aliases for code that uses uppercase string-style codes
  INTERNAL_ERROR = 1,
  NOT_LEADER = 100,
  NOT_SUPPORTED = 9,
  TRANSACTION_ERROR = 10,
}

export interface TransitionalConfig {
  oldMembers: string[];
  newMembers: string[];
  phase: RaftConsensusPhase;
  /** For joint consensus: index of the joint consensus entry */
  newEntryIndex?: number;
  /** Old peer IDs */
  oldPeers?: number[];
  /** New peer IDs */
  newPeers?: number[];
  /** Joint consensus entry index in the log */
  jointEntryIndex?: number;
  /** Timeout for the transitional phase (ms) */
  timeoutMs?: number;
  /** When the transition started (epoch ms) */
  startedAt?: number;
}

export interface LearnerInfo {
  nodeId: string;
  address: string;
  joinTime: number;
  isCaughtUp: boolean;
  /** C3: tracker fields used by RaftGroup */
  nextIndex?: number;
  matchIndex?: number;
  lastHeartbeat?: number;
}

export interface LeaderTransferResult {
  success: boolean;
  newLeaderId?: string;
  /** Compat alias used by extensions */
  newLeader?: string;
  error?: string;
  durationMs: number;
}

export interface PipelineConfig {
  enabled: boolean;
  maxDepth: number;
  batchSize: number;
  flushIntervalMs: number;
  minBatchSize: number;
  timeoutMs: number;
  /** Additional fields used by ReplicationPipeline */
  batchIntervalMs?: number;
  maxPipelineQueueSize?: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: true,
  maxDepth: 1000,
  batchSize: 100,
  flushIntervalMs: 10,
  minBatchSize: 1,
  timeoutMs: 5000,
};

export interface PipelinedEntry {
  index: number;
  term: number;
  data: string | Buffer;
  timestamp: number;
  /** Whether the entry has been flushed to the wire */
  flushed?: boolean;
  /** Whether the peer has acknowledged reception */
  acknowledged?: boolean;
  /** Timestamp when the entry was sent */
  sentAt?: number;
}

export interface FlexibleQuorumConfig {
  writeQuorum: number;
  readQuorum: number;
  commitQuorum: number;
  dynamic: boolean;
  healthyCount: number;
  unhealthyCount: number;
}

export function resolveFlexibleQuorumConfig(
  config?: Partial<FlexibleQuorumConfig>,
  total?: number,
): FlexibleQuorumConfig {
  const n = total ?? 3;
  const majority = Math.floor(n / 2) + 1;
  return {
    writeQuorum: config?.writeQuorum ?? majority,
    readQuorum: config?.readQuorum ?? 1,
    commitQuorum: config?.commitQuorum ?? majority,
    dynamic: config?.dynamic ?? false,
    healthyCount: config?.healthyCount ?? n,
    unhealthyCount: config?.unhealthyCount ?? 0,
  };
}

export function majorityQuorum(total: number): number {
  return Math.floor(total / 2) + 1;
}

export interface InstallSnapshotRequest {
  term: number;
  leaderId: number;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: Buffer;
  done: boolean;
  offset: number;
}

export interface InstallSnapshotResponse {
  term: number;
  success: boolean;
  bytesStored: number;
}

export interface AdaptiveElectionConfig {
  enabled: boolean;
  windowSize: number;
  multiplier: number;
  minTick: number;
  maxTick: number;
  baseElectionTick: number;
  /** G4: RTT sample window size for moving average */
  rttSampleWindow?: number;
  /** Tick interval in ms for RTT-to-tick conversion */
  tickIntervalMs?: number;
  /** How often to recalculate the election tick (ms) */
  recalculationIntervalMs?: number;
  /** Compatibility alias for multiplier */
  rttMultiplier?: number;
}

export const DEFAULT_ADAPTIVE_ELECTION_CONFIG: AdaptiveElectionConfig = {
  enabled: false,
  windowSize: 10,
  multiplier: 2.0,
  minTick: 5,
  maxTick: 40,
  baseElectionTick: 10,
};

export interface CompressionConfig {
  enabled: boolean;
  algorithm: 'zstd' | 'none';
  threshold: number;
  level: number;
}

export interface ScaleRequest {
  nodeId: string;
  action: 'add' | 'remove';
  shardIds?: string[];
  force?: boolean;
  /** For SafeScaler compatibility */
  peerIds?: string[];
}

export interface ScaleResult {
  success: boolean;
  nodeId: string;
  action: 'add' | 'remove';
  affectedShards: string[];
  durationMs?: number;
  errors?: string[];
  /** For SafeScaler compatibility */
  affectedGroups?: string[];
  /** For SafeScaler compatibility */
  error?: string;
}

export interface RollingUpgradeStatus {
  currentPhase: RollingUpgradePhase;
  nodeId: string;
  startTime: number;
  progress: number;
  error?: string;
  /** Compatibility fields */
  phase?: RollingUpgradePhase;
  completedAt?: number;
  startedAt?: number;
}

export enum RollingUpgradePhase {
  IDLE = 'idle',
  PENDING = 'pending',
  DRAIN = 'drain',
  DRAINING = 'draining',
  TRANSFER = 'transfer',
  LEADERSHIP_TRANSFER = 'leadership_transfer',
  UPGRADE = 'upgrade',
  UPGRADING = 'upgrading',
  REJOIN = 'rejoin',
  REJOINING = 'rejoining',
  VERIFY = 'verify',
  COMPLETE = 'complete',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLBACK = 'rollback',
  ROLLING_BACK = 'rolling_back',
}

export interface StreamMuxFrame {
  streamId: number;
  flags: number;
  shardId: number;
  payload: Buffer;
}
