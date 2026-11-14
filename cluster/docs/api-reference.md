# db-cluster API Reference

## Core Types

### `RaftCluster`

The primary entry point. Manages a Raft cluster of nodes.

```typescript
class RaftCluster {
  constructor(config: ClusterConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  propose(command: Command): Promise<ProposeResult>;
  addNode(node: NodeInfo): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  getLeader(): NodeInfo | null;
  getState(): ClusterState;
}
```

### `ClusterConfig`

```typescript
interface ClusterConfig {
  clusterId: string;
  nodes: NodeInfo[];
  dataDir: string;
  electionTimeoutMs?: number;    // default: 1000
  heartbeatIntervalMs?: number;  // default: 300
  maxLogEntries?: number;         // default: 100000
  snapshotThreshold?: number;     // default: 10000
  transport?: TransportConfig;
}
```

## Joint Consensus

### `RaftJointConsensusEngine`

```typescript
class RaftJointConsensusEngine {
  constructor(cluster: RaftCluster);
  proposeJointConfig(oldNodes: NodeInfo[], newNodes: NodeInfo[]): Promise<void>;
  getPhase(): 'stable' | 'joint' | 'finalizing';
  getPendingConfig(): JointConfig | null;
}
```

## Fencing

### `FencingToken`

```typescript
class FencingToken {
  readonly term: number;
  readonly leaderId: string;
  readonly tokenEpoch: number;
  static current: FencingToken | null;
  validate(token: FencingToken): boolean;
  increment(): FencingToken;
}
```

## Observability

### `LoggingAdapter`

```typescript
class LoggingAdapter implements ILogger {
  constructor(component: string, logger?: pino.Logger);
  trace(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(err: Error, msg?: string): void;
  fatal(err: Error, msg?: string): void;
  child(bindings: Record<string, unknown>): ILogger;
}
```

### `RaftMetricsCollector`

```typescript
class RaftMetricsCollector {
  counter(name: string, labels?: Record<string, string>): Counter;
  gauge(name: string, labels?: Record<string, string>): Gauge;
  histogram(name: string, buckets?: number[]): Histogram;
  snapshot(): MetricsSnapshot;
  toPrometheusText(): string;
}
```

### `HealthProbe`

```typescript
class HealthProbe {
  constructor(probes: IHealthCheck[]);
  liveness(): ProbeResult;   // "should restart?"
  readiness(): ProbeResult;  // "can serve traffic?"
  startup(): ProbeResult;    // "initialized?"
  addProbe(probe: IHealthCheck): void;
  removeProbe(name: string): void;
}
```

## Transport

### `ITransport`

```typescript
interface ITransport {
  send(nodeId: string, message: RaftMessage): Promise<void>;
  broadcast(message: RaftMessage, exclude?: string[]): Promise<void>;
  onMessage(handler: (msg: RaftMessage) => void): void;
  close(): Promise<void>;
}
```

## Error Hierarchy

```
Error
├── RaftError
│   ├── NotLeaderError
│   ├── StaleTermError
│   └── JointConsensusError
├── FencingError
├── TransportError
└── ShardError
    ├── ShardNotFoundError
    └── ShardMigrationError
```
