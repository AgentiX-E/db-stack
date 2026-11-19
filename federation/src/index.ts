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
export type { SyncResult } from './interfaces/replication/IAntiEntropy';
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
export { FederationManager } from './core/FederationManager';
export type {
  FederationManagerConfig,
  IFederationConsumer,
  ReplicatedEntry,
  ConflictEntry,
} from './core/FederationManager';

// ConflictResolver
export { ConflictResolver } from './replication/ConflictResolver';
export type {
  ConflictStrategy,
  ConflictValue,
  ConflictResult,
  ConflictPredicate,
  CustomResolver,
} from './replication/ConflictResolver';

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
export type { CDCManagerConfig, CDCTarget, CDCEvent, CDCEventHandler } from './core/CDCManager';
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

// AntiEntropy
export { AntiEntropy } from './replication/AntiEntropy';
export type { MerkleNode, DataEntry, DataProvider } from './replication/AntiEntropy';

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
