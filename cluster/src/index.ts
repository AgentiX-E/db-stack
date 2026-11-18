/**
 * @agentix-e/db-cluster — public API.
 *
 * Layering (bottom → top):
 *
 *   storage      SqliteStorage / SqliteNodeStorage — durable Raft log + metadata
 *   transport    RaftTcpTransport (+ mTLS), batching, compression, circuit breaker
 *   consensus    RaftAdapter, RaftGroup(Manager), joint consensus, read index,
 *                leader transfer, snapshots, sessions, watches
 *   cluster      sharding, HA failover + fencing, PITR, WAL streaming
 *   observability metrics, health probes, structured logging
 *
 * Everything exported here is loadable from the published ESM build; the
 * test harnesses live in the separate `@agentix-e/db-cluster/testing` entry.
 */

// ── Consensus ─────────────────────────────────────────────
export { RaftAdapter } from './consensus/core/RaftAdapter';
export type {
  RaftConfig,
  CommittedEntry,
  QuorumHealth,
  Membership,
  MembershipChangeReason,
  MembershipChangeResult,
} from './consensus/core/RaftAdapter';
export { RaftGroup } from './consensus/core/RaftGroup';
export type { RaftGroupQuorumResult } from './consensus/core/RaftGroup';
export { RaftGroupManager } from './consensus/core/RaftGroupManager';
export type {
  RaftGroupDescriptor,
  RaftHealthStatus,
  RaftPeerStatus,
  TransportReconnectConfig,
} from './consensus/core/RaftGroupManager';
export { ShardStateMachine } from './consensus/core/ShardStateMachine';
export type { ShardStateMachineCallbacks } from './consensus/core/ShardStateMachine';
export { RaftJointConsensusEngine } from './consensus/joint-consensus/RaftJointConsensusEngine';
export type {
  TransitionPhase,
  TransitionResult,
  TransitionOptions,
  MembershipChangeEvent,
} from './consensus/joint-consensus/IClusterMembershipTransition';

// ── Consensus extensions ──────────────────────────────────
export { InstallSnapshotHandler } from './consensus/extensions/InstallSnapshotHandler';
export type { InstallSnapshotHandlerConfig, SnapshotChunkResult } from './consensus/extensions/InstallSnapshotHandler';
export { LeaderTransferHandler } from './consensus/extensions/LeaderTransferHandler';
export type { LeaderTransferHandlerConfig } from './consensus/extensions/LeaderTransferHandler';
export { LeaseReadManager } from './consensus/extensions/LeaseReadManager';
export { ReadIndexManager } from './consensus/extensions/ReadIndexManager';
export type { ReadIndexRequest } from './consensus/extensions/ReadIndexManager';
export { FencingManager } from './consensus/fencing/FencingManager';
export type { FencingConfig, FencingShardStatus, FencingStatus, FenceState } from './consensus/fencing/FencingManager';
export { SessionManager } from './consensus/session/SessionManager';
export type { SessionConfig, SessionEntry, ISessionManager } from './consensus/session/SessionManager';
export { EventBus } from './consensus/events/EventBus';
export type {
  ConsensusEvent,
  RaftEvent,
  RaftRole,
  LeaderElectedEvent,
  LeaderLostEvent,
  StepDownEvent,
  ProposalCommittedEvent,
  ProposalAppliedEvent,
  SnapshotCreatedEvent,
  SnapshotRestoredEvent,
  RoleChangedEvent,
  MembershipChangedEvent,
} from './consensus/events/EventBus';
export { WatchApi } from './consensus/watch/WatchApi';
export { AdaptiveElectionTimeout } from './consensus/opt/AdaptiveElectionTimeout';
export { PeerCircuitBreakerWrapper } from './consensus/opt/CircuitBreaker';
export type { CircuitBreakerMetric, PeerCircuitBreakerOptions } from './consensus/opt/CircuitBreaker';

// ── Transport ─────────────────────────────────────────────
export { RaftTcpTransport } from './consensus/transport/RaftTcpTransport';
export type { RaftTcpTransportConfig, RaftNodeConfig } from './consensus/transport/RaftTcpTransport';
export { BatchedRaftTransport } from './consensus/transport/BatchedRaftTransport';
export { SharedBatchedTransport } from './consensus/transport/SharedBatchedTransport';
export { NodeTransport } from './consensus/transport/NodeTransport';
export { RaftTransportAdapter } from './consensus/transport/RaftTransportAdapter';
export { MessageCodec } from './consensus/transport/MessageCodec';
export { ConnectionPool, PeerConnection } from './consensus/transport/ConnectionPool';
export type { PeerInfo, PeerTlsVerifyOptions } from './consensus/transport/ConnectionPool';
export { MessageCompressor } from './consensus/helpers/MessageCompressor';
export { crc32 } from './consensus/helpers/crc32';

// ── Storage ───────────────────────────────────────────────
export { SqliteStorage } from './consensus/storage/SqliteStorage';
export type {
  SqliteStorageOptions,
  CompactionConfig,
  RaftLogEntry,
  RaftSnapshotMeta,
  StorageStats,
} from './consensus/storage/SqliteStorage';
export {
  SqliteNodeStorage,
  SqliteMetaStorage,
  SqliteLogStorage,
  SqliteSnapshotStorage,
  SqliteConfigStorage,
} from './consensus/storage/SqliteNodeStorage';

// ── High availability ─────────────────────────────────────
export { HAFailoverDetector } from './ha/HAFailoverDetector';
export { HAFailoverCoordinator } from './ha/HAFailoverCoordinator';
export { HAClientManager } from './ha/HAClientManager';
export { HAConsistencyVerifier } from './ha/HAConsistencyVerifier';
export { ClockCompensator } from './ha/ClockCompensator';

// ── Sharding ──────────────────────────────────────────────
export { ShardManager } from './shard/ShardManager';
export { ReshardPlanner } from './shard/ReshardPlanner';
export { OnlineShardMigration } from './shard/OnlineShardMigration';
export { HashShardStrategy, RangeShardStrategy, ConsistentHashStrategy } from './shard/ShardStrategy';

// ── Snapshots / streaming / PITR ──────────────────────────
export { SnapshotManager } from './snapshot/SnapshotManager';
export { WalStreamer } from './stream/WalStreamer';
export { PITRManager } from './pitr/PITRManager';

// ── Observability ─────────────────────────────────────────
export { HealthProbe } from './observability/HealthProbe';
export { LoggingAdapter, traceContext } from './observability/LoggingAdapter';
export { RaftMetricsCollector } from './observability/RaftMetricsCollector';

// ── Storage engines (engine-agnostic SPI) ─────────────────
export { MemoryStorageEngine } from './engines/MemoryStorageEngine';
export {
  EngineBackedReplica,
  encodeSnapshotEnvelope,
  decodeSnapshotEnvelope,
  SNAPSHOT_ENVELOPE_VERSION,
} from './engines/EngineBackedReplica';
export type { EngineBackedReplicaOptions, SnapshotEnvelope } from './engines/EngineBackedReplica';
export type { IStorageEngine, EngineApplyContext } from './interfaces/IStorageEngine';
export type { IShardReplica, ApplyEntry } from './interfaces/IShardReplica';

// ── Interfaces & shared types ─────────────────────────────
export { IConsensusLayer, TopologyChange, IClusterTopology } from './consensus/interfaces/interfaces';
export type { IOutboxWriter, OutboxRecord } from './interfaces/IOutboxWriter';
export { IWalStorage } from './interfaces/wal/IWalStorage';
export { IShardManager } from './interfaces/shard/IShardManager';
export { IShardStrategy } from './interfaces/shard/IShardStrategy';
export { IReshardPlanner, ReshardPlan, IMigrationProgress } from './interfaces/shard/IReshardPlanner';
export { IOnlineShardMigration, IMigrationConfig } from './interfaces/shard/IOnlineShardMigration';
export { IFailoverDetector, FailoverDetectorConfig } from './interfaces/ha/IFailoverDetector';
export {
  IFailoverCoordinator,
  FailoverAction,
  FailoverState,
  FailoverCoordinatorConfig,
} from './interfaces/ha/IFailoverCoordinator';
export { IHAClientManager } from './interfaces/ha/IHAClientManager';
export { IHAConsistencyVerifier, IVerificationResult } from './interfaces/ha/IHAConsistencyVerifier';
export { IFencingManager } from './interfaces/ha/IFencingManager';
export { ITransportReceiver } from './interfaces/transport/ITransportReceiver';
export { MerkleTree } from './consensus/anti-entropy/MerkleTree';
export {
  ConsensusRole,
  MembershipChange,
  LogEntry,
  RaftMessage,
  SnapshotMeta,
  NodeHealth,
  OperationResult,
  SqlVecError,
} from './interfaces/types';
