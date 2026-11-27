// Transport
export type { ITransport } from './interfaces/transport/ITransport';
export type { TransportMessage } from './interfaces/transport/TransportMessage';
export type { InboundMessage } from './interfaces/transport/InboundMessage';
export { InProcessTransport } from './transport/InProcessTransport';
export type { InProcessTransportConfig } from './transport/InProcessTransport';

// Outbox
export type { IOutboxStore } from './interfaces/outbox/IOutboxStore';
export type { OutboxEntry, OutboxEntryInput, OutboxStatus } from './interfaces/outbox/OutboxEntry';
export { OutboxStore } from './storage/OutboxStore';
export type { OutboxStoreConfig, DeadLetterEntry } from './storage/OutboxStore';
export { DEFAULT_RETENTION, deriveRetention, RetentionViolation } from './storage/retention';
export type { RetentionRequest, RetentionRule, RetentionWindows } from './storage/retention';

// HLC
export type { IHLCTimestamp } from './interfaces/hlc/IHLCTimestamp';
export { HLC, compareHLC, happenedBefore, hlcToKey, keyToHlc, makeHLC } from './hlc/HLC';

// Shared types
export type { PeerInfo, TransportStats, OutboxStats, HLCStatus } from './interfaces/types';

// Replication
export type { TopologyType } from './interfaces/replication/IMultiLeaderReplication';
export type { ReplicationTarget } from './interfaces/replication/IMultiLeaderReplication';
export type { ReplicationConfig } from './interfaces/replication/IMultiLeaderReplication';
export type { ReplicationStatus } from './interfaces/replication/IMultiLeaderReplication';
export type { IMultiLeaderReplication } from './interfaces/replication/IMultiLeaderReplication';
export { MultiLeaderReplication } from './replication/MultiLeaderReplication';
export type { MultiLeaderReplicationOptions } from './replication/MultiLeaderReplication';

export type { CDCChangeEvent } from './interfaces/replication/ICDCManager';
export type { CDCSubscription } from './interfaces/replication/ICDCManager';
export type { ICDCEngine } from './interfaces/replication/ICDCManager';
export type { ICDCPublication } from './interfaces/replication/ICDCManager';
export type { ICDCManager } from './interfaces/replication/ICDCManager';

export type { ReplicationSlot } from './interfaces/replication/IReplicationSlotManager';
export type { IReplicationSlotManager } from './interfaces/replication/IReplicationSlotManager';

export type { AntiEntropyConfig } from './interfaces/replication/IAntiEntropy';
export type { SyncResult, DatasetDigest, DigestLeaf } from './interfaces/replication/IAntiEntropy';
export type { IAntiEntropy } from './interfaces/replication/IAntiEntropy';

// DedupRing
export { DedupRing } from './replication/DedupRing';
export type { DedupRingConfig } from './replication/DedupRing';

// Topology
export { TopologyManager } from './topology/TopologyManager';
export type { TopologyConfig, TopologyChangeEvent } from './topology/TopologyManager';

// HealthMonitor
export { HealthMonitor } from './monitoring/HealthMonitor';
export type { HealthMonitorConfig, TargetHealth, FederationHealth } from './monitoring/HealthMonitor';

// FederationManager
export { DCSplitBrainDetector } from './core/DCSplitBrainDetector';
export type { DCSplitBrainConfig } from './core/DCSplitBrainDetector';
export type { DCHeartbeat, SplitBrainEvent } from './core/DCSplitBrainDetector';

// Control protocols — anti-entropy, heartbeat and bootstrap over the transport.
export { AntiEntropyProtocol } from './core/AntiEntropyProtocol';
export type { AntiEntropyProtocolConfig, AntiEntropyProtocolStatus, PeerRootReport } from './core/AntiEntropyProtocol';
export { HeartbeatProtocol } from './core/HeartbeatProtocol';
export type { HeartbeatProtocolConfig, HeartbeatProtocolStatus, HeartbeatPeerReport } from './core/HeartbeatProtocol';
export { SnapshotBootstrap } from './core/SnapshotBootstrap';
export type {
  SnapshotBootstrapConfig,
  SnapshotBootstrapStatus,
  BootstrapSource,
  TransferReport,
} from './core/SnapshotBootstrap';
export { AE_SUMMARY_TYPE, AE_PUSH_TYPE, isAntiEntropyFrame } from './replication/antientropyFrames';
export type { SummaryBody, SummaryRequestBody, SummaryReplyBody, PushBody } from './replication/antientropyFrames';
export { HEARTBEAT_TYPE, isHeartbeatFrame } from './core/heartbeatFrame';
export type { HeartbeatBody } from './core/heartbeatFrame';
export {
  BOOTSTRAP_REQUEST_TYPE,
  BOOTSTRAP_CHUNK_TYPE,
  BOOTSTRAP_DONE_TYPE,
  HANDOFF_TYPE,
  HANDOFF_END_TYPE,
  BOOTSTRAP_FRAME_TYPES,
  isBootstrapFrame,
} from './replication/bootstrapFrames';
export type {
  BootstrapRequestBody,
  BootstrapChunkBody,
  BootstrapDoneBody,
  HandoffEntryBody,
  HandoffEndBody,
  BootstrapFrame,
} from './replication/bootstrapFrames';
export { FederationManager } from './core/FederationManager';
export type {
  FederationManagerConfig,
  IFederationConsumer,
  InboundOutcome,
  ReplicatedEntry,
  ConflictEntry,
} from './core/FederationManager';

// F-17 — failure detection joined to resource-level recovery. `CatastrophicFailoverManager`
// was the last component the package root did not export: it is no longer a simulation
// since IT-94 wired its recover hook, and IT-96 connected it to the detector in production.
export { CatastrophicFailoverManager } from './core/CatastrophicFailoverManager';
export type { CatastrophicFailoverHooks, DCHealthStatus } from './core/CatastrophicFailoverManager';
export { FederationOrchestrator } from './core/FederationOrchestrator';
export type {
  HeartbeatExpiredEvent,
  FailureSignalSource,
  RecoverySignalSource,
  FailoverActions,
  FederationOrchestratorConfig,
  OrchestrationStatus,
} from './core/FederationOrchestrator';

// ConflictResolver
export { ConflictResolver } from './replication/ConflictResolver';
export type {
  ConflictStrategy,
  ConflictValue,
  ConflictResult,
  ConflictPredicate,
  CustomResolver,
} from './replication/ConflictResolver';

// Edge replica — engine-agnostic CDC intake. Exported now that dialing and
// conflict arbitration are caller-supplied callbacks rather than a simulation.
export { EdgeReplica } from './replication/EdgeReplica';
export type {
  EdgeReplicaOptions,
  EdgeTransportHandle,
  EdgeSourceConfig,
  EdgeSyncStatus,
  ReplicationEvent,
  IEdgeReplica,
} from './replication/EdgeReplica';

// CDC
export { CDCEngine } from './replication/CDCEngine';
export type { CDCEngineConfig } from './replication/CDCEngine';
export { CDCPublicationRegistry } from './replication/CDCPublicationRegistry';
export type { CDCPublicationRegistryConfig } from './replication/CDCPublicationRegistry';
// The streaming half of change capture: one engine per remote DC, with lag
// backpressure. `CDCPublicationRegistry` above keeps publications and
// subscriptions; this is the manager `FederationManager.getCDC()` returns, and
// it was the one class in the package that a consumer could not import.
export { CDCManager } from './core/CDCManager';
export type { CDCManagerConfig, CDCDeliveryStats, CDCEvent, CDCEventHandler } from './core/CDCManager';
// The exactly-once pipeline was implemented and tested but never re-exported,
// so consumers could not reach it from the package root.
export { ExactlyOnceCDCPipeline } from './replication/ExactlyOnceCDCPipeline';
export type {
  ExactlyOnceCDCPipelineConfig,
  CDCCheckpoint,
  CDCPipelineMetrics,
  CDCPipelineEvent,
  CDCPipelineEventType,
  CDCPipelineEventHandler,
} from './replication/ExactlyOnceCDCPipeline';
// The confirmation a receiving node sends back. Exported because the *other*
// side of the wire has to be able to send one: a peer implemented against this
// package would otherwise have to re-derive the frame type and its body.
export { buildAckFrame, CDC_ACK_TYPE, parseAck } from './replication/cdcAck';
export type { CdcAckVerdict } from './replication/cdcAck';
export { AckTracker } from './replication/AckTracker';
export type { AckTrackerOptions } from './replication/AckTracker';
export { IncarnationLedger } from './replication/epoch';
export type { EpochVerdict, EpochStatus } from './replication/epoch';

// CDC sinks. None of these were exported, so no consumer could implement a sink
// or reach the retry/batching wrapper: the interface, the in-memory sink and the
// resolver were reachable only from their own tests.
export type { ICDCSink, CDCSinkEvent } from './interfaces/replication/ICDCSink';
export { InMemoryCDCSink } from './replication/InMemoryCDCSink';
export { CDCSinkResolver } from './replication/CDCSinkResolver';
export type {
  CDCSinkResolverConfig,
  ResolverHealth,
  RetryStrategy,
  SinkFailureMode,
  FailureEvent,
} from './replication/CDCSinkResolver';
// The edge between a subscription's target DSN and a sink. Without it a
// subscription recorded a destination that nothing delivered to.
export { CDCSubscriptionPump, projectChangeEvent } from './replication/CDCSubscriptionPump';
export type {
  CDCSubscriptionPumpConfig,
  CDCSubscriptionPumpStatus,
  CDCSinkFactory,
  CDCSinkProjection,
  CDCPumpDropReason,
  CDCPumpEvent,
  CDCPumpEventHandler,
  CDCPumpEventType,
  CDCPumpFailure,
} from './replication/CDCSubscriptionPump';

// The read end of the change stream. `CDCEngine` simulates changes; these read
// a log another process wrote, which is the only way "ordered, resumable
// delivery" can be said about a deployment rather than about a test.
export type { ChangeLogRecord, IChangeLogReader } from './interfaces/replication/IChangeLogReader';
export { compareLsn, formatLsn, parseLsn, recordToChangeEvent } from './interfaces/replication/IChangeLogReader';
export {
  FileChangeLogReader,
  FileChangeLogWriter,
  ChangeLogCorruptError,
  openFileChangeLog,
} from './replication/FileChangeLog';
export type { FileChangeLogOptions, AppendChangeInput } from './replication/FileChangeLog';
export { WalTailCDCEngine } from './replication/WalTailCDCEngine';
export type { WalTailCDCEngineConfig, WalTailCDCEngineStatus } from './replication/WalTailCDCEngine';

// A sink that ends at a socket. The package's only sink used to be in-memory,
// so batching, status handling and timeouts had never crossed a wire.
export { HttpCDCSink, HttpSinkRefusedError } from './replication/HttpCDCSink';
export type { HttpCDCSinkConfig, HttpCDCSinkStats } from './replication/HttpCDCSink';

// The counters as an operator sees them, and the identity they must satisfy.
export {
  pumpConservation,
  pipelineConservation,
  renderPumpMetrics,
  renderPipelineMetrics,
  escapeLabelValue,
} from './monitoring/cdc-metrics';
export type { MetricLabels, PumpConservation, PipelineConservation } from './monitoring/cdc-metrics';
export { comparePositions, isSimulatedEngine } from './replication/ExactlyOnceCDCPipeline';

// AntiEntropy
export { AntiEntropy } from './replication/AntiEntropy';
export type {
  MerkleNode,
  DataEntry,
  DataProvider,
  ApplyOrigin,
  MerklePeer,
  DigestExchange,
} from './replication/AntiEntropy';
export { bucketPrefix } from './replication/AntiEntropy';

// Integration Support
export { TcpSecureTransport } from './transport/TcpSecureTransport';
export type {
  TcpSecureTransportConfig,
  TcpSecureTransportPeer,
  FederationEnvelope,
  IRaftTransport,
} from './transport/TcpSecureTransport';

export { SqlVecFederationConsumer } from './integration/SqlVecFederationConsumer';
export type {
  SqlVecFederationConsumerConfig,
  FederationConsensusLayer,
  FederationOutboxWriter,
} from './integration/SqlVecFederationConsumer';

export { GraphVecFederationConsumer } from './integration/GraphVecFederationConsumer';
export type {
  GraphVecFederationConsumerConfig,
  IGraphVecConsensusProvider,
} from './integration/GraphVecFederationConsumer';

// Query routing and schema federation. The router assigns a query to nodes by load,
// health and geography; the federator watches the schemas those nodes agree on and
// coordinates the migrations that make them agree again. Neither needs to know how
// the replication below them works, and both import their shared vocabulary from
// `@agentix-e/db-node/core`.
export * from './query/index.js';
export * from './schema/index.js';
