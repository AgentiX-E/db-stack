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
  ShardSnapshotMeta,
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
export type { ShardStateMachineCallbacks, ShardStateMachineSnapshot } from './consensus/core/ShardStateMachine';
export { RaftJointConsensusEngine } from './consensus/joint-consensus/RaftJointConsensusEngine';
export type {
  TransitionPhase,
  TransitionResult,
  TransitionOptions,
  MembershipChangeEvent,
  PeerConfig,
  TransitionProgress,
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
export {
  FencingTokenGuard,
  compareFencingTokens,
  formatFencingToken,
  mintFencingToken,
  parseFencingToken,
  stampFencingTokenOnEntry,
} from './consensus/fencing/FencingToken';
export type {
  FencingRefusalObserver,
  FencingToken,
  FencingTokenGuardOptions,
  WriteAdmission,
  WriteRefusalReason,
} from './consensus/fencing/FencingToken';
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
  IEventBus,
  IDisposable,
  EventBusOptions,
} from './consensus/events/EventBus';
export { WatchApi } from './consensus/watch/WatchApi';
export type { WatchOptions } from './consensus/watch/WatchApi';
export { AdaptiveElectionTimeout } from './consensus/opt/AdaptiveElectionTimeout';
export { PeerCircuitBreakerWrapper } from './consensus/opt/CircuitBreaker';
export type { CircuitBreakerMetric, PeerCircuitBreakerOptions } from './consensus/opt/CircuitBreaker';

// ── Transport ─────────────────────────────────────────────
export { RaftTcpTransport } from './consensus/transport/RaftTcpTransport';
export type {
  RaftTcpTransportConfig,
  RaftNodeConfig,
  FramesDroppedEvent,
} from './consensus/transport/RaftTcpTransport';
export { BatchedRaftTransport } from './consensus/transport/BatchedRaftTransport';
export type { TransportPeerStats } from './consensus/transport/BatchedRaftTransport';
export { SharedBatchedTransport } from './consensus/transport/SharedBatchedTransport';
export { NodeTransport } from './consensus/transport/NodeTransport';
export { MessageCodec } from './consensus/transport/MessageCodec';
export type { RaftMessage, RaftEntry } from './consensus/transport/MessageCodec';
export { ConnectionPool, PeerConnection } from './consensus/transport/ConnectionPool';
export type { PeerInfo, PeerTlsVerifyOptions, ConnectionPoolConfig } from './consensus/transport/ConnectionPool';
export { MessageCompressor } from './consensus/helpers/MessageCompressor';
export { crc32 } from './consensus/helpers/crc32';
export { createMonotonicClock } from './consensus/helpers/MonotonicClock';
export type { MonotonicClock, MonotonicClockOptions } from './consensus/helpers/MonotonicClock';

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

// ── Logical primary name ──────────────────────────────────
// A stable address resolved through the cluster's own membership, so failover
// is a protocol event rather than a DNS change. Engine-agnostic: only the
// elected leader id and a live member set are read, through injected callbacks.
export { LogicalPrimaryResolver, resolveLogicalPrimary } from './consensus/routing/LogicalPrimaryResolver';
export type {
  LogicalPrimaryDeps,
  PrimaryMember,
  PrimaryResolution,
  PrimaryResolutionCore,
  PrimaryResolutionInput,
  PrimaryResolutionReason,
} from './consensus/routing/LogicalPrimaryResolver';

// ── Idempotent writes ─────────────────────────────────────
// A retry of the same msgId returns the first attempt's result instead of
// becoming a second write. The dedup window is injected (P3-83's dedupMs), and
// the write callback is engine-agnostic.
export { IdempotencyTable, IdempotentWriteCoordinator } from './consensus/idempotency/Idempotency';
export type {
  IdempotencyRecord,
  IdempotencyTableOptions,
  IdempotentOutcome,
  IdempotentWriteCoordinatorOptions,
} from './consensus/idempotency/Idempotency';

// ── High availability ─────────────────────────────────────
export { HAFailoverDetector } from './ha/HAFailoverDetector';
export type { FailoverEvent, FailoverEventType } from './ha/HAFailoverDetector';
export { HAFailoverCoordinator } from './ha/HAFailoverCoordinator';
export type { HAStatus } from './ha/HAFailoverCoordinator';
export { HAClientManager } from './ha/HAClientManager';
export type { HAClientConfig } from './ha/HAClientManager';
export { HAConsistencyVerifier } from './ha/HAConsistencyVerifier';
export { ClockCompensator } from './ha/ClockCompensator';
export type { ClockCompensatorConfig } from './ha/ClockCompensator';

// ── Sharding ──────────────────────────────────────────────
export { ShardManager } from './shard/ShardManager';
export type { ShardAssignedCallback, ShardRemovedCallback } from './shard/ShardManager';
export { ReshardPlanner } from './shard/ReshardPlanner';
export { ReshardShapeExecutor } from './shard/ReshardShapeExecutor';
export type { ReshardShapeOptions } from './shard/ReshardShapeExecutor';
export type {
  IReshardShapeExecutor,
  ReshardShapeOutcome,
  ReshardShapeRequest,
} from './interfaces/shard/IReshardShapeExecutor';
export { OnlineShardMigration } from './shard/OnlineShardMigration';
export { HashShardStrategy, RangeShardStrategy, ConsistentHashStrategy } from './shard/ShardStrategy';
export type { RangeShardBoundary } from './shard/ShardStrategy';

// ── Snapshots / streaming / PITR ──────────────────────────
export { SnapshotManager } from './snapshot/SnapshotManager';
export type { SnapshotDescriptor, VerificationResult } from './snapshot/ISnapshotManager';
export { WalStreamer } from './stream/WalStreamer';
export type { StreamAck, StreamFilter, StreamSubscription } from './stream/IWalStreamer';
export { PITRManager } from './pitr/PITRManager';
export type { PITRCheckpoint, PITRRestoreResult, WALEntry } from './pitr/PITRManager';

// ── Observability ─────────────────────────────────────────
export { HealthProbe, DEFAULT_PROBE_TIMEOUT_MS } from './observability/HealthProbe';
export type {
  HealthStatus,
  ProbeResult,
  ProbeAnswer,
  ProbeTimer,
  HealthProbeOptions,
  ListenerFailure,
} from './observability/HealthProbe';
export { createHealthFailureReporter, ignoreListenerFailure } from './observability/ListenerFailureReporter';
export type { ListenerFailureEvent, ListenerFailureReporter } from './observability/ListenerFailureReporter';
export { createClusterHealth } from './observability/ClusterHealth';
export type { ClusterHealth, ClusterHealthOptions } from './observability/ClusterHealth';
export { LoggingAdapter, traceContext } from './observability/LoggingAdapter';
export type { ILogger } from './observability/interfaces';
export { RaftMetricsCollector } from './observability/RaftMetricsCollector';
export type { RaftMetricsSnapshot } from './observability/RaftMetricsCollector';

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
export type { IPITRHook } from './interfaces/IPITRHook';
export type { Entry, IMerkleTreeSync } from './interfaces/IMerkleTreeSync';

// ── Interfaces & shared types ─────────────────────────────
export { IConsensusLayer, TopologyChange, IClusterTopology } from './consensus/interfaces/interfaces';
export type { IOutboxWriter, OutboxRecord } from './interfaces/IOutboxWriter';
export { IWalStorage } from './interfaces/wal/IWalStorage';
export { IShardManager } from './interfaces/shard/IShardManager';
export { IShardStrategy } from './interfaces/shard/IShardStrategy';
export { IReshardPlanner, ReshardPlan, IMigrationProgress } from './interfaces/shard/IReshardPlanner';
export { IOnlineShardMigration, IMigrationConfig, IMigrationStatus } from './interfaces/shard/IOnlineShardMigration';
export { IShardMigrationSource, ShardScanEntry, ShardVolumeStats } from './interfaces/shard/IShardMigrationSource';
export { IShardMigrationSink } from './interfaces/shard/IShardMigrationSink';
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
export { MerkleTree } from './consensus/anti-entropy/MerkleTree';
export {
  ConsensusRole,
  MembershipChange,
  LogEntry,
  SnapshotMeta,
  NodeHealth,
  OperationResult,
  SqlVecError,
  RaftConsensusPhase,
  SqlVecErrorCode,
} from './interfaces/types';
export type {
  AdaptiveElectionConfig,
  CompressionConfig,
  FlexibleQuorumConfig,
  InstallSnapshotRequest,
  InstallSnapshotResponse,
  LeaderTransferResult,
  LearnerInfo,
  SharedTransport,
  TransitionalConfig,
} from './interfaces/types';
