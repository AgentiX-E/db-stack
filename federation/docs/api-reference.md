# db-federation API Reference

## Core Types

### `FederationEngine`

The primary entry point. Manages cross-cluster data federation.

```typescript
class FederationEngine {
  constructor(config: FederationConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(source: ClusterRef, target: ClusterRef): Promise<Session>;
  getSession(sessionId: string): Session | undefined;
  getStatus(): FederationStatus;
}
```

### `FederationConfig`

```typescript
interface FederationConfig {
  engineId: string;
  clusters: ClusterRef[];
  pipeline?: PipelineConfig;
  dedupRingSize?: number;      // default: 10000
  reorderWindowMs?: number;    // default: 5000
  heartbeatIntervalMs?: number;// default: 10000
  backupVerifyIntervalMs?: number;
}
```

## Outbox

### `OutboxStore`

```typescript
class OutboxStore {
  constructor(db: IDatabase, tableName?: string);
  append(change: DataChange): Promise<void>;
  extractBatch(maxSize: number): Promise<DataChange[]>;
  ackBatch(changeIds: string[]): Promise<void>;
  getPendingCount(): Promise<number>;
  getOldestPendingAge(): Promise<number>;
  compact(): Promise<void>;
}
```

### `DataChange`

```typescript
interface DataChange {
  changeId: string;
  sessionId: string;
  operation: 'insert' | 'update' | 'delete';
  table: string;
  key: string;
  before?: unknown;
  after?: unknown;
  hlc: HLCTimestamp;
  traceId: string;
}
```

## Deduplication

### `DedupRing`

```typescript
class DedupRing {
  constructor(size: number);
  checkAndMark(changeId: string): boolean;  // true = duplicate
  contains(changeId: string): boolean;
  size(): number;
  reset(): void;
}
```

## Hybrid Logical Clock

### `HLC`

```typescript
class HLC {
  now(): HLCTimestamp;
  update(remote: HLCTimestamp): void;
  compare(a: HLCTimestamp, b: HLCTimestamp): number;
}

interface HLCTimestamp {
  wallClock: number;    // milliseconds since epoch
  logicalCounter: number;
}
```

## Pipeline

### `PipelineBuilder`

```typescript
class PipelineBuilder {
  stage(stage: IFederationStage): this;
  build(): IFederationPipeline;
}

interface IFederationPipeline {
  execute(batch: DataChange[]): Promise<ExecResult>;
  getMetrics(): PipelineMetrics;
}

interface IFederationStage<TIn, TOut> {
  readonly name: string;
  process(batch: TIn[]): Promise<TOut[]>;
  onError(error: Error, batch: TIn[]): ErrorAction;
}
```

## Session

### `SessionManager`

```typescript
class SessionManager {
  constructor(config: SessionConfig);
  createSession(source: ClusterRef, target: ClusterRef): Promise<Session>;
  getSession(sessionId: string): Session | undefined;
  stopSession(sessionId: string): Promise<void>;
  recoverSessions(): Promise<Session[]>;
  getHeartbeat(sessionId: string): HeartbeatStatus;
}
```

## Backup Verification

### `BackupVerifier`

```typescript
class BackupVerifier {
  constructor(source: ClusterRef, target: ClusterRef);
  computeChecksum(table: string): Promise<string>;
  compareChecksums(table: string): Promise<VerificationResult>;
  detectTampering(baseline: string): Promise<TamperReport>;
}
```

## Session Heartbeat

### `HeartbeatStatus`

```typescript
interface HeartbeatStatus {
  sessionId: string;
  lastHeartbeat: number;
  healthy: boolean;
  lagMs: number;
  pendingChanges: number;
}
```

## Error Hierarchy

```
Error
├── FederationError
│   ├── SessionNotFountError
│   ├── OutboxOverflowError
│   ├── DedupOverflowError
│   ├── ChecksumMismatchError
│   ├── SchemaMismatchError
│   └── PipelineError
├── NetworkError
│   ├── ConnectionTimeoutError
│   └── TransportError
└── HLCError
    └── ClockSkewError
```

## Standard Pipeline Stage Order

```
Extract → Serialize → Compress → Transmit → Decompress →
Deserialize → Deduplicate → Reorder → Validate → Apply → Verify
```

## Metrics Exported

| Metric | Type | Label | Stage |
|--------|------|-------|-------|
| `fed_batches_processed` | Counter | `session_id` | All |
| `fed_items_processed` | Counter | `session_id`, `stage` | All |
| `fed_items_duplicated` | Counter | `session_id` | Dedup |
| `fed_items_reordered` | Counter | `session_id` | Reorder |
| `fed_items_failed` | Counter | `session_id`, `stage`, `error` | All |
| `fed_batch_latency_ms` | Histogram | `session_id`, `stage` | All |
| `fed_outbox_pending` | Gauge | `session_id` | Extract |
| `fed_lag_ms` | Gauge | `session_id` | Session |
